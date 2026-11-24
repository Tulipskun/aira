// Gemini 1 answers as a JSON object:
//   { "Isla": "...", "summery": "...", "mood": "...", "color": "#rrggbb" }
//
// `Isla` is what the user sees on Discord and what gets stored as her reply; `summery` is a
// one-line recap of the turn used for memory/context and never shown to the user. `mood` is her
// feeling in Thai (shown in the embed footer) and `color` is that feeling as a hex colour (the
// embed's accent bar).
//
// The API is asked to enforce the shape (response_format + schema), but structured output is a
// constraint on generation, not a guarantee that the text is parseable by us -- a truncated turn,
// a retried request, or a model that ignores the format all land here as plain text. So parsing is
// defensive and always yields something sendable: on failure the raw text becomes `Isla` and the
// reply is flagged `parsed: false` so the caller can log it. `mood`/`color` are decoration, so a
// bad value from the model costs the decoration and nothing else.

export const RPS_CHOICES = ["rock", "paper", "scissors"] as const;
export type RpsChoice = typeof RPS_CHOICES[number];

export const ISLA_REPLY_SCHEMA = {
  type: "object",
  properties: {
    Isla: {
      type: "string",
      description: "ข้อความตอบกลับของไอล่าถึง {{partner}} คงคาแรคเตอร์และน้ำเสียงของไอล่าไว้ ห้ามใส่เครื่องหมายอัญประกาศหรือคำอธิบายรูปแบบ JSON",
    },
    summery: {
      type: "string",
      description: "สรุปสั้น ๆ หนึ่งบรรทัดของบทสนทนาในเทิร์นนี้ ({{partner}} พูดอะไร + ไอล่าตอบอะไร) ใช้เก็บเป็นความทรงจำ ไม่ใช่ข้อความที่จะถูกส่งออกไป",
    },
    mood: {
      type: "string",
      description: "อารมณ์ของไอล่าในขณะนั้น เป็นคำภาษาไทยสั้น ๆ 1-3 คำ เช่น ยินดี, อาย, งอน, เศร้า, สงบ, สนุก, หวง, คิดถึง",
    },
    color: {
      type: "string",
      description: "สีแทนอารมณ์ของไอล่า เป็น hex 6 หลักขึ้นต้นด้วย # เช่น #F1C40F (ยินดี), #E91E63 (อาย), #3498DB (เศร้า), #1ABC9C (สงบ)",
    },
    rps: {
      type: "string",
      enum: [...RPS_CHOICES],
      description: "เลือก rock, paper หรือ scissors เฉพาะเมื่อข้อความตอบของไอล่าในเทิร์นนี้เป็นการชวนหรือรับคำชวนเป่ายิ้งฉุบ และไอล่าตัดสินใจเล่นจริง; ถ้าไม่ได้เล่นให้เว้นฟิลด์นี้",
    },
  },
  required: ["Isla", "summery", "mood", "color"],
} as const;

export type IslaReply = {
  isla: string;
  summery: string;
  mood: string;
  /** Her mood as a 24-bit RGB integer, ready for `EmbedBuilder.setColor()`. */
  color?: number;
  /** RPS choice selected by Gemini 1 for an interactive game in this turn. */
  rps?: RpsChoice;
  /** The colour exactly as the model wrote it, kept so an unusable one can be named in the log. */
  colorText: string;
  parsed: boolean;
};

function stripFence(text: string): string {
  // ```json {...} ``` or ``` {...} ```
  const fence = text.match(/^```[a-zA-Z]*\s*\n?([\s\S]*?)\n?```$/);
  return (fence ? fence[1] : text).trim();
}

function braceBlock(text: string): string | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function pick(obj: Record<string, unknown>, keys: string[]): string {
  for (const key of Object.keys(obj)) {
    if (keys.includes(key.toLowerCase())) {
      const value = obj[key];
      if (typeof value === "string") return value.trim();
      if (typeof value === "number" || typeof value === "boolean") return String(value);
    }
  }
  return "";
}

/**
 * Like pick() but keeps the JSON type. Needed for `color`: a numeric `15844367` in the payload is
 * decimal, while the *string* "123456" is almost certainly the hex `#123456` — flattening both to
 * a string first makes them indistinguishable.
 */
function pickRaw(obj: Record<string, unknown>, keys: string[]): string | number | undefined {
  for (const key of Object.keys(obj)) {
    if (!keys.includes(key.toLowerCase())) continue;
    const value = obj[key];
    if (typeof value === "string") return value.trim();
    if (typeof value === "number") return value;
  }
  return undefined;
}

// Accept the documented keys plus the common drifts: `summary` (correct spelling),
// `isla`/`reply`/`message`, `summery`/`summary`/`recap`, `mood`/`emotion`/`feeling`.
const ISLA_KEYS = ["isla", "reply", "message", "text", "response"];
const SUMMARY_KEYS = ["summery", "summary", "recap", "note", "memory"];
const MOOD_KEYS = ["mood", "emotion", "feeling", "อารมณ์"];
const RPS_KEYS = ["rps", "RPS"];

/** Longest footer Discord will render without cutting us off mid-word. */
export const MAX_MOOD_CHARS = 60;

// Thai combining marks (sara/mai that sit around the consonant). Cutting a string right after one
// of these orphans it, so clipping trims them off the end.
const TRAILING_THAI_MARKS = /[\u0E31\u0E34-\u0E3A\u0E47-\u0E4E]+$/;

/**
 * Clip to `max` characters without splitting a Thai consonant from its vowel or tone mark.
 *
 * Exported because the embed footer clips names and nicknames with the same rule — a naive slice
 * there would orphan a mai-ek the same way it orphans a sara here, and two copies of the regex is
 * how the two clip paths would start disagreeing about what fits.
 */
export function clipThai(text: string, max: number): string {
  if (max <= 0) return "";
  if (text.length <= max) return text;
  return text.slice(0, max).replace(TRAILING_THAI_MARKS, "");
}

/** Clip a mood to the footer budget. */
function clipMood(mood: string): string {
  return clipThai(mood, MAX_MOOD_CHARS);
}

// The model is asked for `#rrggbb`, but it has been seen to answer `rrggbb`, `0xrrggbb`,
// `#rrggbbaa`, `rgb(241, 196, 15)` or a plain colour name. All of those mean the same thing to a
// reader, and Discord's setColor() takes only a 24-bit integer -- so normalise here rather than
// losing the colour (or, worse, sending a string the builder rejects).
const NAMED_COLORS: Record<string, string> = {
  red: "ED4245", blue: "3498DB", green: "57F287", yellow: "FEE75C", pink: "E91E63",
  purple: "9B59B6", orange: "E67E22", white: "FFFFFF", black: "000000", grey: "95A5A6",
  gray: "95A5A6", cyan: "1ABC9C", teal: "11806A", gold: "F1C40F", navy: "34495E",
  // Thai colour words, in case she describes the mood's colour instead of encoding it.
  แดง: "ED4245", ชมพู: "E91E63", ม่วง: "9B59B6", ฟ้า: "3498DB", น้ำเงิน: "34495E",
  เขียว: "1F8B4C", เหลือง: "F1C40F", ส้ม: "E67E22", ขาว: "FFFFFF", ดำ: "2C2F33",
  เทา: "95A5A6", คราม: "206694",
};

/**
 * Turn whatever the model wrote in `color` into a 24-bit RGB integer, or undefined when the value
 * is unusable. Never throws.
 */
export function normalizeColor(input: string | number | undefined | null): number | undefined {
  if (typeof input === "number" && Number.isFinite(input)) {
    return input >= 0 && input <= 0xffffff ? Math.trunc(input) : undefined;
  }
  if (typeof input !== "string") return undefined;

  const raw = input.trim().toLowerCase();
  if (!raw) return undefined;

  const rgb = raw.match(/^rgba?\(\s*(\d{1,3})\s*[,\s]\s*(\d{1,3})\s*[,\s]\s*(\d{1,3})\b/);
  if (rgb) return toRgb(Number(rgb[1]), Number(rgb[2]), Number(rgb[3]));

  const named = NAMED_COLORS[raw.replace(/^[#]/, "")];
  if (named) return parseInt(named, 16);

  const hex = raw.replace(/^#/, "").replace(/^0x/, "");
  const expanded =
    /^[0-9a-f]{3}$/.test(hex) ? hex.split("").map((ch) => ch + ch).join("") : hex;
  if (!/^([0-9a-f]{6})([0-9a-f]{2})?$/.test(expanded)) return undefined;
  // An 8-digit value carries alpha; Discord's embed colour is RGB only, so drop it.
  return parseInt(expanded.slice(0, 6), 16);
}

function toRgb(r: number, g: number, b: number): number | undefined {
  if ([r, g, b].some((v) => !Number.isFinite(v) || v < 0 || v > 255)) return undefined;
  return (r << 16) | (g << 8) | b;
}

/**
 * Turn Gemini 1's raw output into { isla, summery, mood, color }. Never throws and never returns an
 * empty `isla` when there is text to send -- a malformed reply degrades to "send what we got", and
 * an unusable mood/color degrades to no decoration rather than losing the reply.
 */
export function parseIslaReply(raw: string | undefined | null): IslaReply {
  const text = (raw ?? "").trim();
  if (!text) return { isla: "", summery: "", mood: "", colorText: "", parsed: false };

  const candidates = [stripFence(text)];
  const block = braceBlock(candidates[0]);
  if (block) candidates.push(block);

  for (const candidate of candidates) {
    if (!candidate.startsWith("{")) continue;
    let value: unknown;
    try {
      value = JSON.parse(candidate);
    } catch {
      continue;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const obj = value as Record<string, unknown>;
    const isla = pick(obj, ISLA_KEYS);
    if (!isla) continue;
    const summery = pick(obj, SUMMARY_KEYS);
    const mood = clipMood(pick(obj, MOOD_KEYS));
    const rawColor = pickRaw(obj, ["color", "colour", "moodcolor", "mood_color", "hex"]);
    const colorText = typeof rawColor === "number" ? String(rawColor) : (rawColor ?? "");
    const color = normalizeColor(rawColor);
    const rawRps = pick(obj, RPS_KEYS).toLowerCase();
    const rps = (RPS_CHOICES as readonly string[]).includes(rawRps) ? rawRps as RpsChoice : undefined;
    return { isla, summery, mood, color, colorText, ...(rps ? { rps } : {}), parsed: true };
  }

  return { isla: text, summery: "", mood: "", colorText: "", parsed: false };
}
