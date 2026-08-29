import { ctxWindowCreate, fakeToolCallResult, sendRequestGemini, type GeminiRequest } from "./gemini.js";
import { embed } from "./memory/embedding.js";
import { saveMemoryVector, searchMemoriesByVector, type Memory } from "./memory/chroma.js";
import { getHistory, saveMessage } from "./sql/history.js";
import { adjustRelationshipStats, getRelationships, type Relationship } from "./sql/relationship.js";

type IncomingMessage = {
  userId: string;
  user: string;
  text: string;
  timestamp: string;
  fileName?: string;
};

type ExecuteItem = { name?: string; args?: Record<string, unknown> };

export type ProcessMessageResult = { text: string; image?: string };

function relationshipInstructions(relationships: Relationship[]): string {
  if (!relationships.length) return "No relationship data is available.";
  return relationships.map((r) => `${r.userName}: state=${r.state}, xp=${r.xp}, affinity=${r.affinity}`).join("\n");
}

function fakeMemoryTool(username: string, memories: Memory[]): InteractionsStep[] {
  return fakeToolCallResult("search_memory", { username }, memories.map((memory) => ({ text: memory.text, timestamp: memory.timestamp })));
}

type InteractionsStep = Parameters<typeof fakeToolCallResult>[2] extends never ? never : ReturnType<typeof fakeToolCallResult>[number];

async function runGemini2(request: GeminiRequest): Promise<ExecuteItem[]> {
  const result = await sendRequestGemini(request, { responseMode: "tool" });
  if (typeof result === "string") return [];
  return result.map((call) => ({ name: call.name, args: call.args }));
}

async function applyExecute(items: ExecuteItem[], userId: string, timestamp: string): Promise<string | undefined> {
  let selectedImage: string | undefined;

  for (const item of items) {
    const args = item.args ?? {};
    switch (item.name) {
      case "adjust_affinity": {
        const delta = Number(args.delta ?? 0);
        if (Number.isFinite(delta)) adjustRelationshipStats(userId, { affinity: delta });
        break;
      }
      case "add_xp": {
        const delta = Number(args.delta ?? 0);
        if (Number.isFinite(delta)) adjustRelationshipStats(userId, { xp: delta });
        break;
      }
      case "set_relationship": {
        const state = typeof args.state === "string" ? args.state : undefined;
        if (state) adjustRelationshipStats(userId, { state });
        break;
      }
      case "ingest_memory": {
        const text = typeof args.text === "string" ? args.text.trim() : "";
        if (!text) break;
        await saveMemoryVector({ id: crypto.randomUUID(), text, userId, timestamp }, await embed(text));
        break;
      }
      case "select_image": {
        if (typeof args.image === "string" && args.image.trim()) selectedImage = args.image.trim();
        break;
      }
    }
  }
  return selectedImage;
}

export async function processMessage(message: IncomingMessage): Promise<ProcessMessageResult> {
  const history = getHistory(50);
  saveMessage({ role: "user", userId: message.userId, user: message.user, text: message.text, timestamp: message.timestamp, fileName: message.fileName });

  const vector = await embed(message.text);
  const memories = await searchMemoriesByVector(vector, 8);
  const relationships = getRelationships([message.userId]);

  const request1 = ctxWindowCreate(
    history,
    message.text,
    message.user,
    message.timestamp,
    message.fileName,
    fakeMemoryTool(message.user, memories),
    message.userId,
  );
  request1.temporary = fakeMemoryTool(message.user, memories);

  const response1 = await sendRequestGemini(request1);
  const responseText = typeof response1 === "string" ? response1 : "";
  saveMessage({ role: "model", text: responseText, timestamp: new Date().toISOString() });

  const responseTimestamp = new Date().toISOString();
  const request2 = ctxWindowCreate(
    history,
    responseText,
    "Isla",
    responseTimestamp,
    undefined,
    fakeToolCallResult("gemini1_response", {}, { text: responseText }),
  );
  request2.messages.push({ role: "model", text: responseText, timestamp: responseTimestamp });
  request2.temporary = fakeToolCallResult("gemini1_response", {}, { text: responseText });

  request2.messages.push({ role: "user", user: message.user, userId: message.userId, text: message.text, timestamp: message.timestamp, ...(message.fileName && { fileName: message.fileName }) });
  const executeItems = await runGemini2(request2);
  const image = await applyExecute(executeItems, message.userId, message.timestamp);

  return { text: responseText, image };
}
