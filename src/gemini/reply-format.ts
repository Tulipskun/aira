// Gemini 1 answers as a JSON object: { "Isla": "...", "summery": "..." }.
//
// `Isla` is what the user sees on Discord and what gets stored as her reply; `summery` is a
// one-line recap of the turn used for memory/context and never shown to the user.
//
// The API is asked to enforce the shape (response_format + schema), but structured output is a
// constraint on generation, not a guarantee that the text is parseable by us -- a truncated turn,
// a retried request, or a model that ignores the format all land here as plain text. So parsing is
// defensive and always yields something sendable: on failure the raw text becomes `Isla` and the
// reply is flagged `parsed: false` so the caller can log it.

export const ISLA_REPLY_SCHEMA = {
  type: "object",
  properties: {
    Isla: {
      type: "string",
      description: "ข้อความตอบกลับของไอล่าถึงผู้ใช้ คงคาแรคเตอร์และน้ำเสียงของไอล่าไว้ ห้ามใส่เครื่องหมายอัญประกาศหรือคำอธิบายรูปแบบ JSON",
    },
    summery: {
      type: "string",
      description: "สรุปสั้น ๆ หนึ่งบรรทัดของบทสนทนาในเทิร์นนี้ (ผู้ใช้พูดอะไร + ไอล่าตอบอะไร) ใช้เก็บเป็นความทรงจำ ไม่ใช่ข้อความที่ส่งให้ผู้ใช้",
    },
  },
  required: ["Isla", "summery"],
} as const;

export type IslaReply = { isla: string; summery: string; parsed: boolean };

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

// Accept the two documented keys plus the common drifts: `summary` (correct spelling),
// `isla`/`reply`/`message`, `summery`/`summary`/`recap`.
const ISLA_KEYS = ["isla", "reply", "message", "text", "response"];
const SUMMARY_KEYS = ["summery", "summary", "recap", "note", "memory"];

/**
 * Turn Gemini 1's raw output into { isla, summery }. Never throws and never returns an empty
 * `isla` when there is text to send -- a malformed reply degrades to "send what we got".
 */
export function parseIslaReply(raw: string | undefined | null): IslaReply {
  const text = (raw ?? "").trim();
  if (!text) return { isla: "", summery: "", parsed: false };

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
    const summery = pick(obj, SUMMARY_KEYS);
    if (!isla) continue;
    return { isla, summery, parsed: true };
  }

  return { isla: text, summery: "", parsed: false };
}
