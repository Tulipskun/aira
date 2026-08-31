import { ctxWindowCreate, fakeToolCallResult, sendRequestGemini, type GeminiRequest } from "../gemini/client.js";
import { prepareMedia, type MediaSource } from "../bot/media.js";
import { ISLA_REPLY_SCHEMA, parseIslaReply } from "../gemini/reply-format.js";
import { currentTimeBlock, thaiTimestamp } from "../gemini/time.js";
import { embed } from "../memory/embedding.js";
import { saveMemoryVector, searchMemoriesByVector } from "../memory/chroma.js";
import { getHistory, saveMessage, type HistoryMessage } from "../sql/history.js";
import {
  addFacts,
  adjustProfileStats,
  bondDescription,
  getUserProfile,
  setBond,
  upsertUserProfile,
  type UserProfile,
} from "../sql/profile.js";
import { bondLabel, bondLadderText, bondLevel } from "../sql/bonds.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config.js";
import type { Interactions } from "@google/genai";

const PROJECT_ROOT = join(import.meta.dirname, "..", "..");
export type IncomingMessage = {
  userId: string;
  user: string;
  text: string;
  timestamp: string;
  fileName?: string;
  /** Media URLs to fetch and attach to this turn. Fetched once, used by both stages. */
  mediaSources?: MediaSource[];
};
type ExecuteItem = { name?: string; args?: Record<string, unknown> };
export type ProcessMessageResult = {
  text: string;
  image?: string;
  /** Isla's mood in Thai, from Gemini 1 -- rendered in the embed footer. */
  mood?: string;
  /** That mood as a 24-bit RGB integer -- the embed's accent colour. Undefined when she sent no
   * usable colour, which must not cost us the reply. */
  color?: number;
};
const systemPrompt = readFileSync(join(PROJECT_ROOT, config.paths.gemini1SystemPrompt), "utf8").trim();
/**
 * Gemini 2's instruction.
 *
 * Deliberately free of anything that changes per turn (the user's current numbers): it only picks
 * operations, and a stable string is what keeps its prompt cache warm. The per-turn state travels
 * in the message instead — see `runGemini2()`.
 */
const gemini2SystemPrompt = [
  "วิเคราะห์บทสนทนาระหว่าง Isla และผู้ใช้ที่ส่งมา ว่า Isla รู้สึกอย่างไร และควรแสดงอารมณ์อย่างไร โดยใช้ tools ที่เกี่ยวข้อง",
  "",
  "เครื่องมือเดียวที่มีคือ execute ซึ่งรับ operations:",
  "- adjust_affection (args: {delta:number}) — ความรู้สึกที่ Isla มีต่อผู้ใช้ เพิ่ม/ลดทีละน้อย (ปกติ -5..5)",
  "- adjust_trust (args: {delta:number}) — ความเชื่อใจ",
  "- add_xp (args: {delta:number}) — คะแนนสะสมของความสัมพันธ์",
  "- set_bond (args: {bond:string}) — เลื่อน/เปลี่ยนระดับความสัมพันธ์ ต้องเป็นไปตามกฎใน <bond_levels> เท่านั้น",
  "- add_facts (args: {facts:string[]}) — ข้อเท็จจริงใหม่เกี่ยวกับผู้ใช้ที่ควรจำได้",
  "- ingest_memory (args: {text:string}) — บันทึกเหตุการณ์สำคัญเป็นความทรงจำระยะยาว",
  "- select_image (args: {image:string}) — เลือกชื่อรูปอารมณ์ที่เข้ากับคำตอบของ Isla",
  "",
  "ส่งเฉพาะ operation ที่บทสนทนานี้ทำให้เปลี่ยนจริง ๆ ถ้าไม่มีอะไรเปลี่ยน ส่ง operations ว่างได้",
  "",
  bondRulesBlock(),
].join("\n");

/**
 * `execute` is the only tool Gemini 2 gets, and this list is the whole contract.
 *
 * Each operation has one canonical spelling plus the aliases the model already learned from the
 * old prompts and from history rows. `applyExecute()` accepts both, so a turn that says
 * `adjust_affinity` still lands on `affection` instead of being silently dropped.
 */
const EXECUTE_OPERATIONS = [
  "adjust_affection",
  "adjust_affinity",
  "adjust_trust",
  "add_xp",
  "set_bond",
  "set_relationship",
  "add_facts",
  "ingest_memory",
  "select_image",
];

/**
 * The fields `args` may carry.
 *
 * `args` used to be a bare `{type:"object"}`, and the model answered by sending five operations with
 * `"args":{}` every time — the names arrived, the values did not, so nothing was ever written and the
 * turn looked like a success. The old code never hit this because each operation was its own tool
 * with its own schema. Merging them into `execute` moved that description burden onto the schema,
 * where the prompt's `(args: {delta:number})` prose is not read as strictly as a `properties` block.
 *
 * One flat object with every field, rather than a per-operation `oneOf`: the API's schema support for
 * unions is untested here, and a description that names which operation uses which field is enough.
 */
const OPERATION_ARGS_SCHEMA = {
  type: "object",
  description: [
    "ค่าของ operation นี้ ใส่เฉพาะฟิลด์ที่ operation นั้นใช้:",
    "adjust_affection/adjust_affinity/adjust_trust/add_xp = {delta};",
    "set_bond/set_relationship = {bond};",
    "add_facts = {facts};",
    "ingest_memory = {text};",
    "select_image = {image}.",
    "ห้ามส่ง args ว่างเปล่าถ้า operation นั้นต้องการค่า",
  ].join(" "),
  properties: {
    delta: {
      type: "number",
      description: "ค่าที่เปลี่ยน (adjust_affection/adjust_trust/add_xp) ปกติ -5..5 สำหรับความรู้สึก, 1..3 สำหรับ xp",
    },
    bond: {
      type: "string",
      description: "ชื่อระดับความสัมพันธ์ใหม่ ต้องเป็นไปตาม <bond_levels> เท่านั้น (set_bond)",
    },
    facts: {
      type: "array",
      description: "ข้อเท็จจริงใหม่เกี่ยวกับผู้ใช้ (add_facts) เป็นข้อความสั้น ๆ หนึ่งเรื่องต่อรายการ",
      items: { type: "string" },
    },
    text: { type: "string", description: "ข้อความความทรงจำระยะยาวที่จะบันทึก (ingest_memory)" },
    image: { type: "string", description: "ชื่อรูปอารมณ์ที่เลือก (select_image)" },
  },
};

const EXECUTE_TOOL: Interactions.Tool = {
  type: "function",
  name: "execute",
  description: "Apply bond, feeling, fact, memory, and image operations decided from the current turn.",
  parameters: {
    type: "object",
    properties: {
      operations: {
        type: "array",
        description: "Operations to apply.",
        items: {
          type: "object",
          properties: {
            name: { type: "string", enum: EXECUTE_OPERATIONS },
            args: OPERATION_ARGS_SCHEMA,
          },
          required: ["name", "args"],
        },
      },
    },
    required: ["operations"],
  },
};

/**
 * What Gemini 1 is told about the person it is talking to.
 *
 * One block from one table: it used to be two (`user_profiles` for identity/facts and
 * `relationships` for state/xp/affinity), read on two round-trips and rendered by two functions.
 */
export function profileBlock(profile: UserProfile | null, currentName?: string): string {
  const name = profile?.userName || currentName || "ไม่ทราบชื่อ";
  const nicknames = profile?.nickname.length ? profile.nickname.join(", ") : "-";
  const facts = profile?.facts.length
    ? profile.facts.map((fact) => `- ${fact.timestamp ? `[${thaiTimestamp(fact.timestamp)}] ` : ""}${fact.text}`).join("\n")
    : "- ไม่มี";
  return [
    "<user_profile>",
    `ชื่อ: ${name}`,
    `ความสัมพันธ์กับ Isla: ${bondDescription(profile)}`,
    `xp: ${profile?.xp ?? 0}`,
    `trust: ${profile?.trust ?? 0}`,
    `affection: ${profile?.affection ?? 0}`,
    `familiarity: ${profile?.familiarity ?? 0}`,
    `ฉายาที่ Isla ตั้งให้: ${nicknames}`,
    `fact:`,
    facts,
    `หมายเหตุ: trust/affection/familiarity เป็นตัวเลขภายใน อย่านำไปพูดกับผู้ใช้และอย่าแปลงเป็นคำพูดตรงตัว`,
    `</user_profile>`,
  ].join("\n");
}

/**
 * What Gemini 2 is told about the current state, and the ladder rules it must obey.
 *
 * Gemini 2 only picks operations, so it gets the numbers and the rungs — not the facts and
 * nicknames, which are Gemini 1's material and would only add tokens to the analysis call.
 */
export function stateBlock(profile: UserProfile | null): string {
  if (!profile) {
    return `<current_state>\nยังไม่มีข้อมูลผู้ใช้คนนี้: bond=stranger (ระดับ 0), xp=0, trust=0, affection=0, familiarity=0\n</current_state>`;
  }
  return [
    "<current_state>",
    `bond: ${profile.bond} (${bondLabel(profile.bond)}, ระดับ ${bondLevel(profile.bond)})`,
    `xp: ${profile.xp}`,
    `trust: ${profile.trust}`,
    `affection: ${profile.affection}`,
    `familiarity: ${profile.familiarity}`,
    `</current_state>`,
  ].join("\n");
}

export function bondRulesBlock(): string {
  return `<bond_levels>\n${bondLadderText()}\n</bond_levels>`;
}

/**
 * Apply one `execute` operation.
 *
 * Returns the image name when the operation was `select_image`, otherwise undefined. Every write
 * goes through `user_profiles`; the alias cases exist because the model was prompted with the old
 * names for the whole life of this bot, and a refused operation must not silently lose the turn.
 */
async function applyOperation(
  op: { name: string; args: Record<string, unknown> },
  userId: string,
  timestamp: string,
  userName: string,
): Promise<string | undefined> {
  const { name, args } = op;
  const delta = Number(args.delta ?? 0);
  switch (name) {
    case "adjust_affection":
    case "adjust_affinity": {
      if (!Number.isFinite(delta)) return undefined;
      adjustProfileStats(userId, { affection: delta, userName });
      return undefined;
    }
    case "adjust_trust": {
      if (!Number.isFinite(delta)) return undefined;
      adjustProfileStats(userId, { trust: delta, userName });
      return undefined;
    }
    case "add_xp": {
      if (!Number.isFinite(delta)) return undefined;
      adjustProfileStats(userId, { xp: delta, userName });
      return undefined;
    }
    case "set_bond":
    case "set_relationship": {
      const to = typeof args.bond === "string" ? args.bond : typeof args.state === "string" ? args.state : undefined;
      if (!to) return undefined;
      const result = setBond(userId, to, userName);
      // A refused rung is a model mistake, not a crash: log it and keep the previous bond.
      if (!result.ok) console.warn(`[PIPELINE] bond change refused for ${userId}: ${result.reason}`);
      return undefined;
    }
    case "add_facts": {
      const raw = args.facts ?? args.fact ?? args.text;
      const list = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [];
      // Strings only: a bare number or null is not a fact, and String()-ing it would store "7".
      const added = addFacts(userId, list.filter((f): f is string => typeof f === "string"), timestamp, userName);
      if (added) console.log(`[PIPELINE] ${userId}: +${added} fact(s)`);
      return undefined;
    }
    case "ingest_memory": {
      const text = typeof args.text === "string" ? args.text.trim() : "";
      if (text) await saveMemoryVector({ id: crypto.randomUUID(), text, userId, timestamp }, await embed(text));
      return undefined;
    }
    case "select_image": {
      const image = typeof args.image === "string" ? args.image.trim() : "";
      return image || undefined;
    }
    default:
      return undefined;
  }
}

/**
 * Operations that cannot do anything without at least one argument. `select_image` is excluded on
 * purpose: an empty image means "no image this turn", which is a legitimate answer.
 */
const OPERATIONS_NEEDING_ARGS = new Set([
  "adjust_affection",
  "adjust_affinity",
  "adjust_trust",
  "add_xp",
  "set_bond",
  "set_relationship",
  "add_facts",
  "ingest_memory",
]);

/** Exported so the operation contract can be tested without a Gemini round-trip. */
export async function applyExecute(items: ExecuteItem[], userId: string, timestamp: string, userName: string): Promise<string | undefined> {
  let selectedImage: string | undefined;
  for (const item of items) {
    if (item.name !== "execute") continue;
    const operations = Array.isArray(item.args?.operations) ? item.args.operations : [];
    for (const operation of operations) {
      if (!operation || typeof operation !== "object") continue;
      const op = operation as { name?: unknown; args?: unknown };
      if (typeof op.name !== "string" || !op.args || typeof op.args !== "object" || Array.isArray(op.args)) continue;
      // An operation with no arguments is a no-op by design, but when *every* operation arrives
      // empty it means the model was not told what to put in `args` — which is exactly how a whole
      // turn's worth of state silently vanished. Say so instead of returning quietly.
      if (OPERATIONS_NEEDING_ARGS.has(op.name) && Object.keys(op.args as object).length === 0) {
        console.warn(`[PIPELINE] ${userId}: gemini2 sent "${op.name}" with empty args -- nothing applied`);
      }
      const image = await applyOperation({ name: op.name, args: op.args as Record<string, unknown> }, userId, timestamp, userName);
      if (image) selectedImage = image;
    }
  }
  return selectedImage;
}

async function runGemini2(message: IncomingMessage, responseText: string, profile: UserProfile | null, media: Interactions.Content[]): Promise<ExecuteItem[]> {
  const analysisInput = [
    `${message.user}: ${message.text}`,
    `Isla: ${responseText}`,
    ``,
    stateBlock(profile),
  ].join("\n");
  const request: GeminiRequest = {
    // Gemini 2 sees the same media as Gemini 1, otherwise it would be asked to write a memory
    // about a photo it never looked at.
    messages: [{ role: "user", userId: message.userId, user: message.user, text: analysisInput, timestamp: new Date().toISOString(), ...(media.length && { media }) }],
  };
  const result = await sendRequestGemini(request, {
    responseMode: "tool",
    tools: [EXECUTE_TOOL],
    systemInstruction: gemini2SystemPrompt,
    debug: { userId: message.userId, userName: message.user },
  });
  return typeof result === "string" ? [] : result.map((call) => ({ name: call.name, args: call.args }));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Stored turns carry the name the author used back then, both in user_name and as the
// "name: " prefix the scheduler merges into text. Re-stamp this sender's past turns with
// their current display name so the model sees one consistent identity after a rename.
export function restateHistory(history: HistoryMessage[], userId: string, user: string): HistoryMessage[] {
  return history.map((entry) => {
    if (entry.role !== "user" || entry.userId !== userId) return entry;
    const stale = entry.user;
    if (!stale || stale === user) return { ...entry, user };
    const text = entry.text.replace(new RegExp(`^${escapeRegExp(stale)}: `, "gm"), `${user}: `);
    return { ...entry, user, text };
  });
}

export async function processMessage(message: IncomingMessage): Promise<ProcessMessageResult> {
  // One line per turn showing where the time went. Cold-start stalls on this host used to
  // be invisible: the log could not tell "the model is slow" from "DNS took 5s".
  let mark = Date.now();
  const lap = (): number => {
    const now = Date.now();
    const ms = now - mark;
    mark = now;
    return ms;
  };

  const history = restateHistory(getHistory(50), message.userId, message.user);
  // Media is fetched here, once, and shared by both stages. It lands inside the `prep` lap
  // of the timing line, so a slow 20 MB download is attributable instead of mysterious.
  const media = await prepareMedia(message.mediaSources ?? []);
  // mediaSummary already names every attachment, so message.fileName (the *first* attachment's
  // name only) would duplicate it: "image0.png, image0.png [image]". Keep fileName as the fallback
  // for turns where media produced no summary at all.
  const fileName = media.summary || message.fileName;
  if (media.parts.length) {
    console.log(`[MEDIA] ${message.user}: ${media.parts.length} part(s) attached — ${media.summary}`);
  }
  saveMessage({ role: "user", userId: message.userId, user: message.user, text: message.text, timestamp: message.timestamp, fileName });
  const prepMs = lap();
  // An empty string is rejected outright by the embedding endpoint (verified: "content contains
  // an empty Part"), and media-only messages are common. Embed what the turn actually is instead.
  const embedText = message.text || media.summary || "(no text)";
  const vector = await embed(embedText);
  const embedMs = lap();
  const memories = await searchMemoriesByVector(vector, 8);
  const chromaMs = lap();
  // One read of one table. This used to be two tables keyed by the same user_id, fetched twice,
  // and rendered by two functions that could disagree about the name.
  let profile = getUserProfile(message.userId);
  // Keep the stored name in step with Discord. `restateHistory()` only fixes what the *model sees*
  // this turn; without this write the row would keep whatever name it was created with, and the
  // next turn's block (and the forget CLI) would show a stale identity. Only the name is written,
  // so bond/xp/facts are never touched here. A first-time user gets their row created here too.
  if (!profile || profile.userName !== message.user) {
    profile = upsertUserProfile({ userId: message.userId, userName: message.user }) ?? profile;
  }
  const identityBlock = profileBlock(profile, message.user);
  // Chroma stores UTC; the model reads Thai local time, same rule as messageStep().
  const temporaryMemory = fakeToolCallResult("search_memory", { user: message.user }, { memories: memories.map((memory) => ({ text: memory.text, timestamp: thaiTimestamp(memory.timestamp) })) });
  const request1 = ctxWindowCreate(history, message.text, message.user, message.timestamp, fileName, temporaryMemory, message.userId, media.parts);
  const buildMs = lap();
  const response1 = await sendRequestGemini(request1, {
    // `currentTimeBlock()` is recomputed per turn on purpose: history and memory only carry the
    // timestamps of *past* rows, so without a server-side "now" the model has nothing to weigh a
    // user's false time claim against (real case: "ยังไม่เที่ยงเลย" typed at 12:46:39+07:00, and
    // Isla agreed with the user over her own context). Gemini 2 deliberately does NOT get it —
    // it only picks tools, and a per-turn instruction string would break its prompt caching.
    systemInstruction: `${systemPrompt}\n\n${identityBlock}\n\n${currentTimeBlock()}`,
    responseFormat: { type: "text", mime_type: "application/json", schema: ISLA_REPLY_SCHEMA },
    debug: { userId: message.userId, userName: message.user },
  });
  const gemini1Ms = lap();
  // Gemini 1 answers as { Isla, summery }. Only `Isla` may reach the user or the history; the
  // recap is metadata. parseIslaReply degrades to "send the raw text" when the model ignores the
  // format, so a malformed turn still gets a reply instead of an empty message.
  const reply = parseIslaReply(typeof response1 === "string" ? response1 : "");
  if (!reply.parsed) {
    console.warn(`[PIPELINE] ${message.user}: Gemini 1 reply was not valid JSON -- sent raw text, no summery/mood/color`);
  } else if (reply.color === undefined) {
    // She named a colour we could not read. The reply still goes out, just without the accent
    // colour -- but say so, because a mood that never paints the embed is otherwise invisible.
    console.warn(
      `[PIPELINE] ${message.user}: gemini1 sent unusable color "${reply.colorText}" -- embed left default`,
    );
  }
  const responseText = reply.isla;
  const responseTimestamp = new Date().toISOString();
  saveMessage({ role: "model", text: responseText, summary: reply.summery || null, timestamp: responseTimestamp });

  const executeItems = await runGemini2(message, responseText, profile, media.parts);
  const gemini2Ms = lap();
  const image = await applyExecute(executeItems, message.userId, message.timestamp, message.user);
  const applyMs = lap();
  console.log(`[PIPELINE] ${message.user}: total=${prepMs + embedMs + chromaMs + buildMs + gemini1Ms + gemini2Ms + applyMs}ms prep=${prepMs} embed=${embedMs} chroma=${chromaMs} build=${buildMs} gemini1=${gemini1Ms} gemini2=${gemini2Ms} apply=${applyMs}`);
  return {
    text: responseText,
    image,
    ...(reply.mood && { mood: reply.mood }),
    ...(reply.color !== undefined && { color: reply.color }),
  };
}
