import { ctxWindowCreate, fakeToolCallResult, sendRequestGemini, type GeminiRequest } from "./gemini.js";
import { embed } from "./memory/embedding.js";
import { saveMemory, searchMemoriesByVector, type Memory } from "./memory/chroma.js";
import { getHistory, saveMessage } from "./sql/history.js";
import { adjustRelationshipStats, getRelationships, type Relationship } from "./sql/relationship.js";
import type { Interactions } from "@google/genai";

export type ProcessMessageInput = {
  userId: string;
  user: string;
  text: string;
  timestamp: string;
  fileName?: string;
  relatedUserIds?: string[];
};

export type ProcessMessageResult = {
  text: string;
  image?: string;
  relationships: Relationship[];
};

const executeTool: Interactions.Tool = {
  type: "function",
  name: "execute",
  description: "Apply required AI state changes for this turn. Return all operations together.",
  parameters: {
    type: "object",
    properties: {
      commands: {
        type: "array",
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

function resolveUserId(username: unknown, currentUserId: string, relationships: Relationship[]): string {
  if (typeof username !== "string" || !username.trim()) return currentUserId;
  const match = relationships.find((r) => r.userName === username);
  return match?.userId ?? currentUserId;
}

async function executeCommands(
  commands: unknown,
  currentUserId: string,
  timestamp: string,
  relationships: Relationship[],
): Promise<string | undefined> {
  if (!Array.isArray(commands)) return undefined;
  let selectedImage: string | undefined;

  for (const command of commands) {
    if (!command || typeof command !== "object") continue;
    const item = command as { name?: unknown; args?: unknown };
    if (typeof item.name !== "string" || !item.args || typeof item.args !== "object") continue;
    const args = item.args as Record<string, unknown>;
    const userId = resolveUserId(args.username, currentUserId, relationships);

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
        await saveMemory({ id: crypto.randomUUID(), text, userId, timestamp, vector: memoryVector });
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

async function runGemini2(
  request: GeminiRequest,
  userId: string,
  timestamp: string,
  systemInstruction: string,
  relationships: Relationship[],
): Promise<string | undefined> {
  const result = await sendRequestGemini(request, {
    responseMode: "tool",
    tools: [executeTool],
    systemInstruction: `${systemInstruction}\nUse usernames, never Discord IDs, in execute command arguments. Return one execute call containing every operation required before the response can be sent.`,
  });
  if (!Array.isArray(result)) return undefined;

  let selectedImage: string | undefined;
  for (const call of result) {
    if (call.name === "execute") {
      const image = await executeCommands(call.args.commands, userId, timestamp, relationships);
      if (image) selectedImage = image;
    }
  }
  return selectedImage;
}

export async function processMessage(input: ProcessMessageInput): Promise<ProcessMessageResult> {
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
  const image = await runGemini2(completedRequest, input.userId, input.timestamp, systemInstruction, relationships);
  const finalRelationships = getRelationships(relatedUserIds);

  return { text: response, image, relationships: finalRelationships };
}
