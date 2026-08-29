import { ctxWindowCreate, fakeToolCallResult, sendRequestGemini, type GeminiRequest } from "../gemini/client.js";
import { embed } from "../memory/embedding.js";
import { saveMemoryVector, searchMemoriesByVector } from "../memory/chroma.js";
import { getHistory, saveMessage } from "../sql/history.js";
import { getRelationships, adjustRelationshipStats, type Relationship } from "../sql/relationship.js";
import { getUserProfiles, type UserProfile } from "../sql/profile.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config.js";

const PROJECT_ROOT = join(import.meta.dirname, "..", "..");

export type IncomingMessage = { userId: string; user: string; text: string; timestamp: string; fileName?: string };
type ExecuteItem = { name?: string; args?: Record<string, unknown> };
export type ProcessMessageResult = { text: string; image?: string };

const systemPrompt = readFileSync(join(PROJECT_ROOT, config.paths.gemini1SystemPrompt), "utf8").trim();

const RELATIONSHIP_LABELS: Record<string, string> = { stranger: "คนแปลกหน้า", friend: "เพื่อน", close_friend: "เพื่อนสนิท", crush: "คนที่ไอล่าชอบ", lover: "คนรัก", soulmate: "คู่ชีวิต", enemy: "ศัตรู", sibling: "พี่น้อง", family: "ครอบครัว" };
function userProfileBlock(profile: UserProfile | null, relationship: Relationship | null): string {
  const name = profile?.name ?? relationship?.userName ?? "ไม่ทราบชื่อ";
  const relationshipText = relationship ? RELATIONSHIP_LABELS[relationship.state] ?? relationship.state : "ไม่มีข้อมูลความสัมพันธ์";
  const nicknames = profile?.nicknames.length ? profile.nicknames.join(", ") : "-";
  const facts = profile?.facts.length ? profile.facts.map((fact) => `- ${fact}`).join("\n") : "- ไม่มี";
  return `<user_profile>\nชื่อ: ${name}\nความสัมพันธ์กับ Isla: ${relationshipText}\nฉายาที่ Isla ตั้งให้: ${nicknames}\nfact:\n${facts}\n</user_profile>`;
}
function userMemoryBlock(memories: { text: string; timestamp: string }[]): string {
  const content = memories.length ? memories.map((memory) => `- ${memory.text}`).join("\n") : "- ไม่มีความทรงจำที่เกี่ยวข้อง";
  return `<user_memory>\n${content}\n</user_memory>`;
}
async function runGemini2(request: GeminiRequest): Promise<ExecuteItem[]> { const result = await sendRequestGemini(request, { responseMode: "tool" }); return typeof result === "string" ? [] : result.map((call) => ({ name: call.name, args: call.args })); }
async function applyExecute(items: ExecuteItem[], userId: string, timestamp: string): Promise<string | undefined> {
  let selectedImage: string | undefined;
  for (const item of items) {
    const args = item.args ?? {};
    switch (item.name) {
      case "adjust_affinity": { const delta = Number(args.delta ?? 0); if (Number.isFinite(delta)) adjustRelationshipStats(userId, { affinity: delta }); break; }
      case "add_xp": { const delta = Number(args.delta ?? 0); if (Number.isFinite(delta)) adjustRelationshipStats(userId, { xp: delta }); break; }
      case "set_relationship": { const state = typeof args.state === "string" ? args.state : undefined; if (state) adjustRelationshipStats(userId, { state }); break; }
      case "ingest_memory": { const text = typeof args.text === "string" ? args.text.trim() : ""; if (text) await saveMemoryVector({ id: crypto.randomUUID(), text, userId, timestamp }, await embed(text)); break; }
      case "select_image": { if (typeof args.image === "string" && args.image.trim()) selectedImage = args.image.trim(); break; }
    }
  }
  return selectedImage;
}

export async function processMessage(message: IncomingMessage): Promise<ProcessMessageResult> {
  const history = getHistory(50);
  saveMessage({ role: "user", userId: message.userId, user: message.user, text: message.text, timestamp: message.timestamp, fileName: message.fileName });
  const vector = await embed(message.text);
  const memories = await searchMemoriesByVector(vector, 8);
  const relationship = getRelationships([message.userId])[0] ?? null;
  const profile = getUserProfiles([message.userId])[0] ?? null;
  const profileBlock = userProfileBlock(profile, relationship);
  const memoryBlock = userMemoryBlock(memories.map((m) => ({ text: m.text, timestamp: m.timestamp ?? "" })));
  const request1 = ctxWindowCreate(history, message.text, message.user, message.timestamp, message.fileName, undefined, message.userId);
  const response1 = await sendRequestGemini(request1, { systemInstruction: `${systemPrompt}\n\n${profileBlock}\n\n${memoryBlock}` });
  const responseText = typeof response1 === "string" ? response1 : "";
  const responseTimestamp = new Date().toISOString();
  saveMessage({ role: "model", text: responseText, timestamp: responseTimestamp });
  const request2 = ctxWindowCreate(history, responseText, "Isla", responseTimestamp, undefined, fakeToolCallResult("gemini1_response", {}, { text: responseText }));
  request2.messages.push({ role: "model", text: responseText, timestamp: responseTimestamp });
  request2.temporary = fakeToolCallResult("gemini1_response", {}, { text: responseText });
  request2.messages.push({ role: "user", user: message.user, userId: message.userId, text: message.text, timestamp: message.timestamp, ...(message.fileName && { fileName: message.fileName }) });
  const executeItems = await runGemini2(request2);
  const image = await applyExecute(executeItems, message.userId, message.timestamp);
  return { text: responseText, image };
}
