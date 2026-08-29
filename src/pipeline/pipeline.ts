import { ctxWindowCreate, fakeToolCallResult, sendRequestGemini, type GeminiRequest } from "../gemini/client.js";
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
export type IncomingMessage = { userId: string; user: string; text: string; timestamp: string; fileName?: string };
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

async function runGemini2(message: IncomingMessage, responseText: string, relationship: Relationship | null): Promise<ExecuteItem[]> {
  const analysisInput = `${message.user}: ${message.text}\nIsla: ${responseText}\n\n${relationshipBlock(relationship)}`;
  const request: GeminiRequest = {
    messages: [{ role: "user", userId: message.userId, user: message.user, text: analysisInput, timestamp: new Date().toISOString() }],
  };
  const result = await sendRequestGemini(request, {
    responseMode: "tool",
    tools: [EXECUTE_TOOL],
    systemInstruction: gemini2SystemPrompt,
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
  const history = restateHistory(getHistory(50), message.userId, message.user);
  saveMessage({ role: "user", userId: message.userId, user: message.user, text: message.text, timestamp: message.timestamp, fileName: message.fileName });
  const vector = await embed(message.text);
  const memories = await searchMemoriesByVector(vector, 8);
  const relationship = getRelationships([message.userId])[0] ?? null;
  const profile = getUserProfiles([message.userId])[0] ?? null;
  const profileBlock = userProfileBlock(profile, relationship, message.user);
  const temporaryMemory = fakeToolCallResult("search_memory", { user: message.user }, { memories: memories.map((memory) => ({ text: memory.text, timestamp: memory.timestamp ?? "" })) });
  const request1 = ctxWindowCreate(history, message.text, message.user, message.timestamp, message.fileName, temporaryMemory, message.userId);
  const response1 = await sendRequestGemini(request1, { systemInstruction: `${systemPrompt}\n\n${profileBlock}` });
  const responseText = typeof response1 === "string" ? response1 : "";
  const responseTimestamp = new Date().toISOString();
  saveMessage({ role: "model", text: responseText, timestamp: responseTimestamp });

  const executeItems = await runGemini2(message, responseText, relationship);
  const image = await applyExecute(executeItems, message.userId, message.timestamp, message.user);
  return { text: responseText, image };
}
