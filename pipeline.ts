import { ctxWindowCreate, fakeToolCallResult, sendRequestGemini, type GeminiRequest } from "./gemini";
import { embed } from "./memory/embedding";
import { saveMemory, searchMemoriesByVector, type Memory } from "./memory/chroma";
import { getHistory, saveMessage } from "./sql/history";
import { adjustRelationshipStats, getRelationships, type Relationship } from "./sql/relationship";
import type { Interactions } from "@google/genai";

export type ProcessMessageInput = {
  userId: string;
  user: string;
  text: string;
  timestamp: string;
  fileName?: string;
  relatedUserIds?: string[];
};

const executeTool: Interactions.Tool = {
  type: "function",
  name: "execute",
  description: "Apply background AI state changes. Return all required operations together.",
  parameters: {
    type: "object",
    properties: {
      commands: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            args: { type: "object" },
          },
          required: ["name", "args"],
        },
      },
    },
    required: ["commands"],
  },
};

function relationshipInstructions(relationships: Relationship[]): string {
  if (!relationships.length) return "No relationship data is available for the users involved in this turn.";
  return ["Relationship state for relevant users:", ...relationships.map((r) => `- ${r.userName}: state=${r.state}, xp=${r.xp}, affinity=${r.affinity}`)].join("\n");
}

function memoryContext(username: string, memories: Memory[]): Interactions.Step[] {
  return fakeToolCallResult("search_memory", { username }, memories.map((memory) => ({ text: memory.text, timestamp: memory.timestamp, metadata: memory.metadata })));
}

function addModelResponse(request: GeminiRequest, response: string, timestamp: string): GeminiRequest {
  return { ...request, messages: [...request.messages, { role: "model", text: response, timestamp }] };
}

async function executeCommands(commands: unknown, currentUserId: string, timestamp: string): Promise<void> {
  if (!Array.isArray(commands)) return;
  await Promise.all(commands.map(async (command) => {
    if (!command || typeof command !== "object") return;
    const item = command as { name?: unknown; args?: unknown };
    if (typeof item.name !== "string" || !item.args || typeof item.args !== "object") return;
    const args = item.args as Record<string, unknown>;

    switch (item.name) {
      case "adjust_affinity": {
        const userId = typeof args.user_id === "string" ? args.user_id : currentUserId;
        const delta = Number(args.delta ?? 0);
        if (Number.isFinite(delta)) adjustRelationshipStats(userId, { affinity: delta });
        return;
      }
      case "add_xp": {
        const userId = typeof args.user_id === "string" ? args.user_id : currentUserId;
        const delta = Number(args.delta ?? 0);
        if (Number.isFinite(delta)) adjustRelationshipStats(userId, { xp: delta });
        return;
      }
      case "set_relationship": {
        const userId = typeof args.user_id === "string" ? args.user_id : currentUserId;
        const state = typeof args.state === "string" ? args.state : undefined;
        if (state) adjustRelationshipStats(userId, { state });
        return;
      }
      case "ingest_memory": {
        const text = typeof args.text === "string" ? args.text.trim() : "";
        if (!text) return;
        const userId = typeof args.user_id === "string" ? args.user_id : currentUserId;
        await saveMemory({ id: crypto.randomUUID(), text, userId, timestamp });
        return;
      }
      default:
        return;
    }
  }));
}

async function runBackground(request: GeminiRequest, userId: string, timestamp: string, systemInstruction: string): Promise<void> {
  const result = await sendRequestGemini(request, {
    responseMode: "tool",
    tools: [executeTool],
    systemInstruction: `${systemInstruction}\nReturn one execute call containing every background operation required for this turn.`,
  });
  if (!Array.isArray(result)) return;
  for (const call of result) {
    if (call.name === "execute") await executeCommands(call.args.commands, userId, timestamp);
  }
}

export async function processMessage(input: ProcessMessageInput): Promise<string> {
  const history = getHistory(Number(process.env.HISTORY_LIMIT ?? 50));
  const request = ctxWindowCreate(history, input.text, input.user, input.timestamp, input.fileName, [], input.userId);

  saveMessage({ role: "user", userId: input.userId, user: input.user, text: input.text, timestamp: input.timestamp, fileName: input.fileName });

  const vector = await embed(input.text);
  const memories = await searchMemoriesByVector(vector, Number(process.env.MEMORY_RESULTS ?? 5));
  const relatedUserIds = [...new Set([input.userId, ...(input.relatedUserIds ?? [])])];
  const relationships = getRelationships(relatedUserIds);
  const systemInstruction = relationshipInstructions(relationships);
  const temporary = [...(request.temporary ?? []), ...memoryContext(input.user, memories)];
  const gemini1Request = { ...request, temporary };

  const response = await sendRequestGemini(gemini1Request, { responseMode: "text", systemInstruction }) as string;
  saveMessage({ role: "model", text: response, timestamp: input.timestamp });

  const completedRequest = addModelResponse(gemini1Request, response, input.timestamp);
  setTimeout(() => {
    void runBackground(completedRequest, input.userId, input.timestamp, systemInstruction).catch((error) => {
      console.error("[PIPELINE] background processing failed", error);
    });
  }, 0);

  return response;
}
