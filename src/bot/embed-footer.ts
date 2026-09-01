/**
 * The embed footer — who you are talking to, and how she feels about it.
 *
 * Two lines:
 *
 *   Farris (คนรัก) ❤️ 109 [+15] [Flirt +1] #คนโปรด #คนขี้แกล้ง
 *   อารมณ์: สงบ
 *
 * Line 1 is the relationship card: display name (max 12 chars), the bond's Thai label, its mark, the
 * accumulated xp, this turn's badges, and the nicknames she gave this user. The badges are the turn's
 * receipts — `[+15]` what the xp moved, `[Flirt +1]` a flirt she took, `[Lover Unlocked]` a rung this
 * turn newly reached.
 * Line 2 is her own mood, which Gemini 1 reports every turn (see `gemini/reply-format.ts`).
 *
 * Everything here is *derived from data the caller already has* — nothing is looked up and nothing
 * is invented:
 *  - an unknown bond contributes no label and no mark, rather than a guess;
 *  - `xpDelta` of 0 or absent contributes no bracket, so a turn that changed nothing does not
 *    claim it did;
 *  - no nicknames means no `#` tags at all.
 *
 * Clipping is Thai-mark-safe (see `clipThai()` in reply-format): cutting a name mid-vowel leaves a
 * floating combining mark in the footer, which is exactly the kind of glitch a display string
 * should never produce.
 */

import { bondEmoji, bondLabel, bondUnlockLabel, isBond } from "../sql/bonds.js";
import { clipThai } from "../gemini/reply-format.js";

/** Hard cap from the owner: the name never takes more room than this in the footer. */
export const MAX_NAME_CHARS = 12;
/** Nicknames are free text she wrote; keep the card scannable. */
export const MAX_NICKNAMES = 3;
export const MAX_NICKNAME_CHARS = 24;
/** Mood budget shared with the parser's own clip, so the footer cannot be widened by drift. */
export const MAX_MOOD_CHARS = 60;

/** Footer text when there is no profile at all — the old default, kept for that one case. */
export const FALLBACK_FOOTER = "Isla";

/** The relationship card — everything line 1 is built from. */
export type UserStatus = {
  /** Discord display name for this turn. */
  userName?: string | null;
  /** Rung on the ladder (`lover`, `enemy`, …). Anything unknown renders as no status. */
  bond?: string | null;
  /** Accumulated xp after this turn. */
  xp?: number | null;
  /** What this turn moved it by. 0 / absent renders nothing. */
  xpDelta?: number | null;
  /**
   * Accepted flirts this turn. 1 renders `[Flirt +1]`; 0 / absent renders nothing.
   *
   * Comes from the writer (`applyTurnState()`), not from Gemini 2's `is_flirt`, so the badge cannot
   * claim a flirt the counter never received.
   */
  flirtDelta?: number | null;
  /**
   * This turn *reached* a new rung worth announcing -> `[Lover Unlocked]`.
   *
   * A demotion is false here even though the rung changed; see `isBondUnlock()`.
   */
  bondUnlocked?: boolean | null;
  /** Nicknames she gave this user, in storage order. */
  nickname?: string[] | null;
};

export type FooterInput = UserStatus & {
  /** Her mood this turn, in Thai. */
  mood?: string | null;
};

/** Clip to `max` characters, spending the last one on an ellipsis so the total stays <= max. */
function clip(text: string, max: number): string {
  if (max <= 0) return "";
  if (text.length <= max) return text;
  if (max === 1) return "…";
  return clipThai(text, max - 1) + "…";
}

/** The name as the footer may show it: trimmed, mark-safe, at most MAX_NAME_CHARS. */
export function footerNameOf(userName?: string | null): string {
  const name = (userName ?? "").replace(/\s+/g, " ").trim();
  return clip(name, MAX_NAME_CHARS);
}

/** One `#tag`, with the characters that would break the tag pattern removed. */
function nicknameTag(nickname: string): string {
  // `#` is dropped rather than spaced out: a tag containing a space is two tags that lost an
  // argument. Newlines become spaces so a multi-line nickname still reads as one tag.
  const text = nickname.replace(/#/g, "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  return `#${clip(text, MAX_NICKNAME_CHARS)}`;
}

/** `#คนโปรด #คนขี้แกล้ง` — capped, empty when she has named them nothing. */
export function nicknameTagsOf(nickname?: string[] | null): string {
  if (!Array.isArray(nickname)) return "";
  return nickname
    .map((entry) => (typeof entry === "string" ? nicknameTag(entry) : ""))
    .filter(Boolean)
    .slice(0, MAX_NICKNAMES)
    .join(" ");
}

/** `+12` / `-5` — the sign is part of the string so the caller never has to format it. */
export function xpDeltaText(xpDelta?: number | null): string {
  if (xpDelta === undefined || xpDelta === null || !Number.isFinite(xpDelta)) return "";
  const delta = Math.trunc(xpDelta);
  if (delta === 0) return "";
  return delta > 0 ? `+${delta}` : String(delta);
}

/**
 * The badges that follow the xp: `[+15] [Flirt +1] [Lover Unlocked]`.
 *
 * Each is built from data the writer already confirmed, and each is absent rather than zero-valued:
 *  - `[+15]` — this turn's xp movement (0 or non-finite renders nothing);
 *  - `[Flirt +1]` — a flirt accepted *this* turn; a count of 1 or more renders `+1`, because the
 *    ladder accepts at most one per turn and a larger number would be a bug, not a bigger deal;
 *  - `[Lover Unlocked]` — the rung this turn reached, only when the ladder says it is announceable.
 */
export function statusBadges(input: UserStatus): string[] {
  const badges: string[] = [];

  const delta = xpDeltaText(input.xpDelta);
  if (delta) badges.push(`[${delta}]`);

  if (typeof input.flirtDelta === "number" && Number.isFinite(input.flirtDelta) && Math.trunc(input.flirtDelta) > 0) {
    badges.push(`[Flirt +${Math.trunc(input.flirtDelta)}]`);
  }

  if (input.bondUnlocked && isBond(input.bond)) {
    const name = bondUnlockLabel(input.bond);
    if (name) badges.push(`[${name} Unlocked]`);
  }

  return badges;
}

/**
 * Line 1: `Farris (คนรัก) ❤️ 109 [+15] [Flirt +1] #คนโปรด #คนขี้แกล้ง`
 *
 * Returns "" when there is no name to build a card around, which is what lets the caller fall back
 * to `FALLBACK_FOOTER` instead of shipping a footer of stray punctuation.
 */
export function statusLineOf(input: FooterInput): string {
  const name = footerNameOf(input.userName);
  if (!name) return "";

  const parts: string[] = [name];
  if (isBond(input.bond)) {
    parts.push(`(${bondLabel(input.bond)})`);
    const mark = bondEmoji(input.bond);
    if (mark) parts.push(mark);
  }
  if (typeof input.xp === "number" && Number.isFinite(input.xp)) parts.push(String(Math.trunc(input.xp)));
  parts.push(...statusBadges(input));
  const tags = nicknameTagsOf(input.nickname);
  if (tags) parts.push(tags);
  return parts.join(" ");
}

/** Line 2: `อารมณ์: สงบ` — "" when she sent no usable mood. */
export function moodLineOf(mood?: string | null): string {
  const text = (mood ?? "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  return `อารมณ์: ${clip(text, MAX_MOOD_CHARS)}`;
}

/**
 * The whole footer as one string.
 *
 * Discord renders `\n` inside `footer.text`, so the two lines travel in a single field — there is
 * no second footer. When the relationship card cannot be built (no name — e.g. a turn from a user
 * with no profile) the mood line still shows, and when neither is available we fall back to the
 * plain "Isla" the footer used to always say.
 */
export function buildFooterText(input: FooterInput): string {
  const lines = [statusLineOf(input), moodLineOf(input.mood)].filter(Boolean);
  return lines.length ? lines.join("\n") : FALLBACK_FOOTER;
}
