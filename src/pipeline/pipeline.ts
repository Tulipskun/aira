import { ctxWindowCreate, fakeToolCallResult, sendRequestGemini, type GeminiRequest } from "../gemini/client.js";
import { prepareMedia, type MediaSource } from "../bot/media.js";
import { ISLA_REPLY_SCHEMA, parseIslaReply } from "../gemini/reply-format.js";
import { currentTimeBlock, thaiTimestamp } from "../gemini/time.js";
import { embed } from "../memory/embedding.js";
import { saveMemoryVector, searchMemoriesByVector } from "../memory/chroma.js";
import { getHistory, saveMessage, type HistoryMessage } from "../sql/history.js";
import { getRelationships, adjustRelationshipStats, type Relationship } from "../sql/relationship.js";
import { getUserProfiles, type UserProfile } from "../sql/profile.js";
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
export type ProcessMessageResult = { text: string; image?: string };
const systemPrompt = readFileSync(join(PROJECT_ROOT, config.paths.gemini1SystemPrompt), "utf8").trim();
const gemini2SystemPrompt = "วิเคราะห์บทสนทนาระหว่าง Isla และผู้ใช้ที่ส่งมา ว่า Isla รู้สึกอย่างไร และควรแสดงอารมณ์อย่างไร โดยใช้ tools ที่เกี่ยวข้อง";
const RELATIONSHIP_LABELS: Record<string, string> = { stranger: "คนแปลกหน้า", friend: "เพื่อน", close_friend: "เพื่อนสนิท", crush: "คนที่ไอล่าชอบ", lover: "คนรัก", soulmate: "คู่ชีวิต", enemy: "ศัตรู", sibling: "พี่น้อง", family: "ครอบครัว" };

const EXECUTE_TOOL: Interactions.Tool = {
  type: "function",
  name: "execute",
  description: "Apply relationship, memory, and image operations decided from the current turn.",
  parameters: {
    type: "object",
    properties: {
      operations: {
        type: "array",
        description: "Operations to apply.",
        items: {
          type: "object",
          properties: {
            name: { type: "string", enum: ["adjust_affinity", "add_xp", "set_relationship", "ingest_memory", "select_image"] },
            args: { type: "object" },
          },
          required: ["name", "args"],
        },
      },
    },
    required: ["operations"],
  },
};

function userProfileBlock(profile: UserProfile | null, relationship: Relationship | null, currentName?: string): string {
  const name = profile?.name ?? relationship?.userName ?? currentName ?? "ไม่ทราบชื่อ";
  const relationshipText = relationship ? RELATIONSHIP_LABELS[relationship.state] ?? relationship.state : "ไม่มีข้อมูลความสัมพันธ์";
  const nicknames = profile?.nicknames.length ? profile.nicknames.join(", ") : "-";
  const facts = profile?.facts.length ? profile.facts.map((fact) => `- ${fact}`).join("\n") : "- ไม่มี";
  return `<user_profile>\nชื่อ: ${name}\nความสัมพันธ์กับ Isla: ${relationshipText}\nฉายาที่ Isla ตั้งให้: ${nicknames}\nfact:\n${facts}\n</user_profile>`;
}

async function applyExecute(items: ExecuteItem[], userId: string, timestamp: string, userName: string): Promise<string | undefined> {
  let selectedImage: string | undefined;
  for (const item of items) {
    if (item.name !== "execute") continue;
    const operations = Array.isArray(item.args?.operations) ? item.args.operations : [];
    for (const operation of operations) {
      if (!operation || typeof operation !== "object") continue;
      const op = operation as { name?: unknown; args?: unknown };
      if (typeof op.name !== "string" || !op.args || typeof op.args !== "object" || Array.isArray(op.args)) continue;
      const args = op.args as Record<string, unknown>;
      switch (op.name) {
        case "adjust_affinity": { const delta = Number(args.delta ?? 0); if (Number.isFinite(delta)) adjustRelationshipStats(userId, { affinity: delta, userName }); break; }
        case "add_xp": { const delta = Number(args.delta ?? 0); if (Number.isFinite(delta)) adjustRelationshipStats(userId, { xp: delta, userName }); break; }
        case "set_relationship": { const state = typeof args.state === "string" ? args.state : undefined; if (state) adjustRelationshipStats(userId, { state, userName }); break; }
        case "ingest_memory": { const text = typeof args.text === "string" ? args.text.trim() : ""; if (text) await saveMemoryVector({ id: crypto.randomUUID(), text, userId, timestamp }, await embed(text)); break; }
        case "select_image": { if (typeof args.image === "string" && args.image.trim()) selectedImage = args.image.trim(); break; }
      }
    }
  }
  return selectedImage;
}

function relationshipBlock(relationship: Relationship | null): string {
  if (!relationship) return "<relationship>\nไม่มีข้อมูลความสัมพันธ์\n</relationship>";
  return `<relationship>\nstate: ${RELATIONSHIP_LABELS[relationship.state] ?? relationship.state}\nxp: ${relationship.xp}\naffinity: ${relationship.affinity}\nfamiliarity: ${relationship.familiarity}\ntrust: ${relationship.trust}\nromanticApproachCount: ${relationship.romanticApproachCount}\nsevereConflictCount: ${relationship.severeConflictCount}\n</relationship>`;
}

async function runGemini2(message: IncomingMessage, responseText: string, relationship: Relationship | null, media: Interactions.Content[]): Promise<ExecuteItem[]> {
  const analysisInput = `${message.user}: ${message.text}\nIsla: ${responseText}\n\n${relationshipBlock(relationship)}`;
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
  const relationship = getRelationships([message.userId])[0] ?? null;
  const profile = getUserProfiles([message.userId])[0] ?? null;
  const profileBlock = userProfileBlock(profile, relationship, message.user);
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
    systemInstruction: `${systemPrompt}\n\n${profileBlock}\n\n${currentTimeBlock()}`,
    responseFormat: { type: "text", mime_type: "application/json", schema: ISLA_REPLY_SCHEMA },
    debug: { userId: message.userId, userName: message.user },
  });
  const gemini1Ms = lap();
  // Gemini 1 answers as { Isla, summery }. Only `Isla` may reach the user or the history; the
  // recap is metadata. parseIslaReply degrades to "send the raw text" when the model ignores the
  // format, so a malformed turn still gets a reply instead of an empty message.
  const reply = parseIslaReply(typeof response1 === "string" ? response1 : "");
  if (!reply.parsed) console.warn(`[PIPELINE] ${message.user}: Gemini 1 reply was not valid JSON -- sent raw text, no summery`);
  const responseText = reply.isla;
  const responseTimestamp = new Date().toISOString();
  saveMessage({ role: "model", text: responseText, summary: reply.summery || null, timestamp: responseTimestamp });

  const executeItems = await runGemini2(message, responseText, relationship, media.parts);
  const gemini2Ms = lap();
  const image = await applyExecute(executeItems, message.userId, message.timestamp, message.user);
  const applyMs = lap();
  console.log(`[PIPELINE] ${message.user}: total=${prepMs + embedMs + chromaMs + buildMs + gemini1Ms + gemini2Ms + applyMs}ms prep=${prepMs} embed=${embedMs} chroma=${chromaMs} build=${buildMs} gemini1=${gemini1Ms} gemini2=${gemini2Ms} apply=${applyMs}`);
  return { text: responseText, image };
}
