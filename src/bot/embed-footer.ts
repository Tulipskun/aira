/**
 * The embed footer — who you are talking to, and how she feels about it.
 *
 * Two lines:
 *
 *   Farris (คนรัก) ❤️ 109 [+15] [Flirt +1] #คนโปรด #คนขี้แกล้ง
 *   อารมณ์: สงบ
 *
 * In a private session the relationship mark is wrapped in parentheses so the private context is
 * visually distinct: `Farris (คนรัก) (❤️) 109`. Global/group sessions keep the existing `❤️` form.
 */

import { bondEmoji, bondLabel, bondUnlockLabel, isBond } from "../sql/bonds.js";
import { clipThai } from "../gemini/reply-format.js";

export const MAX_NAME_CHARS = 12;
export const MAX_NICKNAMES = 3;
export const MAX_NICKNAME_CHARS = 24;
export const MAX_MOOD_CHARS = 60;
export const FALLBACK_FOOTER = "Isla";

export type UserStatus = {
  userName?: string | null;
  bond?: string | null;
  xp?: number | null;
  xpDelta?: number | null;
  flirtDelta?: number | null;
  bondUnlocked?: boolean | null;
  nickname?: string[] | null;
};

export type FooterInput = UserStatus & {
  mood?: string | null;
  /** True when this footer belongs to the user's private `user:<id>` session. */
  privateSession?: boolean;
};

function clip(text: string, max: number): string {
  if (max <= 0) return "";
  if (text.length <= max) return text;
  if (max === 1) return "…";
  return clipThai(text, max - 1) + "…";
}

export function footerNameOf(userName?: string | null): string {
  const name = (userName ?? "").replace(/\s+/g, " ").trim();
  return clip(name, MAX_NAME_CHARS);
}

function nicknameTag(nickname: string): string {
  const text = nickname.replace(/#/g, "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  return `#${clip(text, MAX_NICKNAME_CHARS)}`;
}

export function nicknameTagsOf(nickname?: string[] | null): string {
  if (!Array.isArray(nickname)) return "";
  return nickname
    .map((entry) => (typeof entry === "string" ? nicknameTag(entry) : ""))
    .filter(Boolean)
    .slice(0, MAX_NICKNAMES)
    .join(" ");
}

export function xpDeltaText(xpDelta?: number | null): string {
  if (xpDelta === undefined || xpDelta === null || !Number.isFinite(xpDelta)) return "";
  const delta = Math.trunc(xpDelta);
  if (delta === 0) return "";
  return delta > 0 ? `+${delta}` : String(delta);
}

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

export function statusLineOf(input: FooterInput): string {
  const name = footerNameOf(input.userName);
  if (!name) return "";

  const parts: string[] = [name];
  if (isBond(input.bond)) {
    parts.push(`(${bondLabel(input.bond)})`);
    const mark = bondEmoji(input.bond);
    if (mark) parts.push(input.privateSession ? `(${mark})` : mark);
  }
  if (typeof input.xp === "number" && Number.isFinite(input.xp)) parts.push(String(Math.trunc(input.xp)));
  parts.push(...statusBadges(input));
  const tags = nicknameTagsOf(input.nickname);
  if (tags) parts.push(tags);
  return parts.join(" ");
}

export function moodLineOf(mood?: string | null): string {
  const text = (mood ?? "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  return `อารมณ์: ${clip(text, MAX_MOOD_CHARS)}`;
}

export function buildFooterText(input: FooterInput): string {
  const lines = [statusLineOf(input), moodLineOf(input.mood)].filter(Boolean);
  return lines.length ? lines.join("\n") : FALLBACK_FOOTER;
}
