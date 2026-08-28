import { GoogleGenAI } from "@google/genai";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

export type FileAttachment = { uri: string; mimeType: string };

export type Message = {
  user: string;
  text: string;
  timestamp: string;
  file?: FileAttachment;
};

export type GeminiRequest = {
  messages: Message[];
  temporary?: unknown[];
};

export type FunctionCall = {
  id: string;
  name: string;
  args: Record<string, unknown>;
};

export interface GeminiRequestOptions {
  model?: string;
  apiKey?: string;
  tools?: unknown[];
  responseMode?: "text" | "tool";
}

type KeyState = { gemini1: number; gemini2: number };
const STATE_FILE = process.env.GEMINI_KEY_STATE_FILE ?? ".gemini-key-state.json";

function envKeys(name: string): string[] {
  return (process.env[name] ?? "").split(",").map((key) => key.trim()).filter(Boolean);
}

function loadKeyState(): KeyState {
  if (!existsSync(STATE_FILE)) return { gemini1: 0, gemini2: 0 };
  try {
    const state = JSON.parse(readFileSync(STATE_FILE, "utf8"));
    return {
      gemini1: Number.isInteger(state.gemini1) ? state.gemini1 : 0,
      gemini2: Number.isInteger(state.gemini2) ? state.gemini2 : 0,
    };
  } catch {
    return { gemini1: 0, gemini2: 0 };
  }
}

const keyState = loadKeyState();

function saveKeyState(): void {
  writeFileSync(STATE_FILE, `${JSON.stringify(keyState, null, 2)}\n`);
}

function rotateKey(mode: "gemini1" | "gemini2", count: number): void {
  keyState[mode] = (keyState[mode] + 1) % count;
  saveKeyState();
}

function is429(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as { status?: number; code?: number; response?: { status?: number } };
  return e.status === 429 || e.code === 429 || e.response?.status === 429;
}

function messageStep(message: Message): Record<string, unknown> {
  const content: Record<string, unknown>[] = [
    {
      type: "text",
      text: JSON.stringify({
        user: message.user,
        text: message.text,
        timestamp: message.timestamp,
        ...(message.file && { file: { uri: message.file.uri, mimeType: message.file.mimeType } }),
      }),
    },
  ];

  if (message.file) {
    content.push({
      type: "image",
      uri: message.file.uri,
      mime_type: message.file.mimeType,
    });
  }

  return { type: "user_input", content };
}

export function ctxWindowCreate(
  messages: Message[],
  message: string,
  user: string,
  timestamp: string,
  file?: FileAttachment,
  temporary: unknown[] = []
): GeminiRequest {
  return {
    messages: [...messages, { user, text: message, timestamp, ...(file && { file }) }],
    temporary,
  };
}

export async function sendRequestGemini(
  requestBody: GeminiRequest,
  options: GeminiRequestOptions = {}
): Promise<string | FunctionCall[]> {
  const mode = options.responseMode ?? "text";
  const keys = envKeys(mode === "tool" ? "GEMINI2_API_KEYS" : "GEMINI1_API_KEYS");
  const fallbackKey = options.apiKey ?? process.env.GEMINI_API_KEY;
  if (!keys.length && !fallbackKey) throw new Error(`No API key configured for ${mode}`);

  const model = options.model ?? (mode === "tool"
    ? process.env.GEMINI2_MODEL ?? "gemini-flash-lite-latest"
    : process.env.GEMINI1_MODEL ?? "gemini-flash-lite-latest");
  const stateKey = mode === "tool" ? "gemini2" : "gemini1";
  let lastError: unknown;

  for (let attempt = 0; attempt < (keys.length || 1); attempt++) {
    const key = keys.length ? keys[keyState[stateKey] % keys.length] : fallbackKey!;
    try {
      const ai = new GoogleGenAI({ apiKey: key });
      const response = await ai.interactions.create({
        model,
        input: [
          ...requestBody.messages.map(messageStep),
          ...(requestBody.temporary ?? []),
        ] as never,
        tools: options.tools ?? [],
        ...(mode === "tool"
          ? {
              generation_config: {
                tool_choice: {
                  allowed_tools: { mode: "any" },
                },
              },
            }
          : {}),
        store: false,
      });

      if (mode === "tool") {
        return response.steps
          .filter((step) => step.type === "function_call")
          .map((step) => ({
            id: step.id,
            name: step.name,
            args: step.arguments as Record<string, unknown>,
          }));
      }

      return response.output_text ?? "";
    } catch (error) {
      lastError = error;
      if (!is429(error) || !keys.length) throw error;
      rotateKey(stateKey, keys.length);
    }
  }

  throw lastError;
}
