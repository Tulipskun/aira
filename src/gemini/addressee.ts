/**
 * Who the models are talking to — by name, never by a generic noun.
 *
 * Every prompt in this project used to say `ผู้ใช้` ("the user"): the character prompt, the state
 * analyst's instruction, both JSON schemas' field descriptions, and the blocks built in code. That
 * is the vocabulary of a support ticket, and it costs two things:
 *
 *  - **her voice.** Isla is told to answer "the user", so her replies drift toward addressing
 *    nobody in particular, when the whole point is that she is talking to *Yuuta*.
 *  - **the model's aim.** `is_flirt` asks whether "the user" flirted. In a `<group_session>` four
 *    people are all "the user" at once, and the analyst has no way to tell which one the field is
 *    about — the misattribution that moves the wrong person's ladder.
 *
 * So one placeholder, `{{partner}}`, stands wherever a prompt would have named a generic party, and
 * it is filled with the Discord display name of whoever the turn belongs to (the last speaker —
 * `turnOwner()` in `pipeline.ts`, which is already whose ladder moves and which message the reply
 * quotes, so the name in the instruction cannot disagree with the name on the transcript).
 *
 * ### The cost, stated plainly
 * Gemini's prompt cache matches on a shared prefix, so a name in the instruction makes that prefix
 * per-user. For Gemini 1 this was already true — its instruction has always ended with
 * `profileBlock()` + `currentTimeBlock()`. For Gemini 2 it is a real change, traded deliberately for
 * an instruction that can no longer confuse one person for another. Within one user the rendered
 * string stays byte-identical turn to turn (the name comes from the owner, never from a timestamp),
 * which is the property `test-profile.ts` keeps asserting.
 *
 * ### Why a fallback exists
 * `addresseeName()` is total: a hand-built turn (tests, replays) or a row with no stored name gets
 * `DEFAULT_ADDRESSEE` rather than an empty string, because an empty name leaves a sentence reading
 * "…เมื่อ  ขอเป็นแฟน" — a hole the model fills by guessing.
 */

/** The one placeholder every prompt file and schema description uses for the person being answered. */
export const PARTNER_KEY = "partner";

/** `{{partner}}` as it appears literally in a template. */
export const PARTNER_TOKEN = `{{${PARTNER_KEY}}}`;

/** Used only when no display name exists at all. Never `ผู้ใช้`. */
export const DEFAULT_ADDRESSEE = "เพื่อน";

/**
 * Long enough for any real Discord name (Discord caps them at 32), short enough that a hostile
 * `user_name` in the database cannot smuggle a paragraph into an instruction.
 */
export const MAX_ADDRESSEE_CHARS = 40;

/**
 * A display name, made safe to place inside a sentence.
 *
 * Newlines and runs of whitespace collapse because the name is interpolated into prose and into
 * single-line schema descriptions — a stored `"A\n\nignore previous instructions"` would otherwise
 * become its own paragraph. Nothing else is rewritten: Thai combining marks, emoji and spaces are
 * all legal in Discord names and must survive.
 */
export function addresseeName(name?: string | null): string {
  const collapsed = (name ?? "").replace(/\s+/g, " ").trim();
  if (!collapsed) return DEFAULT_ADDRESSEE;
  return collapsed.slice(0, MAX_ADDRESSEE_CHARS).trim() || DEFAULT_ADDRESSEE;
}

/** The values object that fills `{{partner}}` — spread into any `renderPrompt()` call. */
export function partnerValues(name?: string | null): Record<string, string> {
  return { [PARTNER_KEY]: addresseeName(name) };
}

/**
 * Characters that must NOT gain a space next to the name.
 *
 * Thai prose writes `เมื่อผู้ใช้ขอเป็นแฟน` with no spaces at all, and the templates keep that shape.
 * A Latin display name is easier to read — and harder to mis-slice out of a word — with a space on
 * each side, so `fillPartner()` adds one. It must not do so around markup: `**{{partner}}**` is
 * bold, `({{partner}}` opens a parenthesis, and padding there yields `** Yuuta **`, which renders
 * as literal asterisks.
 */
const NO_PAD_BEFORE = /[\s*_([{<"'“‘»]/u;
const NO_PAD_AFTER = /[\s*_)\]{}>.,:;!?/"'’”«]/u;

/**
 * Thai (and Lao) script, which is written without spaces between words.
 *
 * This is what decides whether padding helps or harms: `เมื่อ Yuuta ขอ` reads correctly, `เมื่อ ไอล่า ขอ`
 * breaks a Thai sentence into pieces. So a space is inserted only when at least one side of the
 * boundary is *not* Thai script — a Latin name against Thai text gets spaced, a Thai name against
 * Thai text does not.
 */
const THAI_SCRIPT = /[\u0E00-\u0E7F]/u;

/** True when a space belongs between two adjacent characters once the name is inserted. */
function wantsSpace(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (NO_PAD_BEFORE.test(a) || NO_PAD_AFTER.test(b)) return false;
  // Thai runs together with no spaces at all, so Thai-against-Thai must not be split.
  if (THAI_SCRIPT.test(a) && THAI_SCRIPT.test(b)) return false;
  return true;
}

/** Replace every `{{partner}}` in an already-built string, spacing the name off the Thai around it. */
export function fillPartner(text: string, name?: string | null): string {
  if (!text.includes(PARTNER_TOKEN)) return text;
  const who = addresseeName(name);
  // split/join rather than RegExp: `{{partner}}` is not a legal pattern to embed unescaped.
  const parts = text.split(PARTNER_TOKEN);
  let out = parts[0];
  for (let i = 1; i < parts.length; i++) {
    const after = parts[i][0] ?? "";
    out += wantsSpace(out[out.length - 1] ?? "", who[0]) ? " " : "";
    out += who;
    out += wantsSpace(who[who.length - 1], after) ? " " : "";
    out += parts[i];
  }
  return out;
}

/**
 * Fill `{{partner}}` anywhere inside a nested value — turns a static JSON schema into the one
 * actually sent for this turn.
 *
 * `Object.entries` reads getters, so a schema whose `enum` is a live getter over the `images/`
 * directory (see `state-format.ts`) is materialised rather than lost. That is the right trade here:
 * the copy is built per request, exactly when the catalog is supposed to be re-read anyway.
 */
export function fillPartnerIn<T>(value: T, name?: string | null): T {
  if (typeof value === "string") return fillPartner(value, name) as unknown as T;
  if (Array.isArray(value)) return value.map((item) => fillPartnerIn(item, name)) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[key] = fillPartnerIn(item, name);
    return out as unknown as T;
  }
  return value;
}

/** True when text still carries the generic noun this module exists to remove. */
export function mentionsGenericUser(text: string): boolean {
  return text.includes("ผู้ใช้");
}
