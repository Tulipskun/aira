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

type ExecuteItem = {
  name?: string;
  args?: Record<string, unknown>;
};

export type ProcessMessageResult = {
  text: string;
  image?: string;
};

function relationshipInstructions(relationships: Relationship[]): string {
  if (!relationships.length) return "No relationship data is available.";
  return relationships.map((r) => `${r.userName}: state=${r.state}, xp=${r.xp}, affinity=${r.affinity}`).join("\n");
}

function fakeMemoryTool(username: string, memories: Memory[]): string {
  return JSON.stringify({
    function: "search_memory",
    arguments: { username },
    result: memories.map((memory) => ({ text: memory.text, timestamp: memory.timestamp })),
  });
}

async function runGemini2(request: GeminiRequest): Promise<ExecuteItem[]> {
  const response = await sendRequestGemini("gemini2", request, {
    forceExecute: true,
  });
  return response.steps
    .filter((step): step is { type: "function_call"; name: string; arguments?: Record<string, unknown> } => step.type === "function_call")
    .map((step) => ({ name: step.name, args: step.arguments }));
}

async function applyExecute(
  items: ExecuteItem[],
  userId: string,
  timestamp: string,
): Promise<string | undefined> {
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
        const memoryVector = await embed(text);
        await saveMemoryVector({ id: crypto.randomUUID(), text, userId, timestamp }, memoryVector);
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
  saveMessage({ role: "user", userId: message.userId, userName: message.user, text: message.text, timestamp: message.timestamp, fileName: message.fileName });

  const vector = await embed(message.text);
  const memories = await searchMemoriesByVector(vector, 8);
  const relationships = getRelationships([message.userId]);

  const request1 = ctxWindowCreate({
    messages: [...history, { role: "user", userId: message.userId, userName: message.user, text: message.text, timestamp: message.timestamp, fileName: message.fileName }],
    instructions: relationshipInstructions(relationships),
    toolResult: fakeMemoryTool(message.user, memories),
  });

  const response1 = await sendRequestGemini("gemini1", request1);
  const responseText = response1.outputText;
  saveMessage({ role: "model", text: responseText, timestamp: new Date().toISOString() });

  const request2 = ctxWindowCreate({
    messages: [...history, { role: "user", userId: message.userId, userName: message.user, text: message.text, timestamp: message.timestamp, fileName: message.fileName }, { role: "model", text: responseText, timestamp: new Date().toISOString() }],
    instructions: relationshipInstructions(relationships),
    toolResult: fakeToolCallResult(responseText),
  });

  const executeItems = await runGemini2(request2);
  const image = await applyExecute(executeItems, message.userId, message.timestamp);

  return { text: responseText, image };
}
