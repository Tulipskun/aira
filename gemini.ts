import { GoogleGenAI } from "@google/genai";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

export type Content =
  | { type: "text"; text: string }
  | { type: "function_call"; id: string; name: string; args: Record<string, unknown> }
  | { type: "function_result"; call_id: string; name?: string; result: unknown };

export type Turn = {
  role: "user" | "model" | "tool";
  content: Content[];
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

type KeyState = {
  gemini1: number;
  gemini2: number;
};

const STATE_FILE = process.env.GEMINI_KEY_STATE_FILE ?? ".gemini-key-state.json";

function envKeys(name: string): string[] {
  return (process.env[name] ?? "")
    .split(",")
    .map((key) => key.trim())
    .filter(Boolean);
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

function rotateKey(mode: "gemini1" | "gemini2", keyCount: number): void {
  keyState[mode] = (keyState[mode] + 1) % keyCount;
  saveKeyState();
}

function is429(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as { status?: number; code?: number; response?: { status?: number } };
  return value.status === 429 || value.code === 429 || value.response?.status === 429;
}

export function user(text: string): Turn {
  return { role: "user", content: [{ type: "text", text }] };
}

export function fakeTool(name: string, args: Record<string, unknown>, result: unknown): Turn[] {
  const callId = `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  return [
    { role: "model", content: [{ type: "function_call", id: callId, name, args }] },
    { role: "tool", content: [{ type: "function_result", call_id: callId, name, result }] },
  ];
}

export function ctxWindowCreate(history: Turn[], message: string, temporaryTurns: Turn[] = []): Turn[] {
  return [...history, user(message), ...temporaryTurns];
}

export async function sendRequestGemini(
  request_body: Turn[],
  options: GeminiRequestOptions = {}
): Promise<string | FunctionCall[]> {
  const mode = options.responseMode ?? "text";
  const keys = mode === "tool" ? envKeys("GEMINI2_API_KEYS") : envKeys("GEMINI1_API_KEYS");
  const fallbackKey = options.apiKey ?? process.env.GEMINI_API_KEY;

  if (keys.length === 0 && !fallbackKey) {
    throw new Error(`No API key configured for ${mode === "tool" ? "Gemini2" : "Gemini1"}`);
  }

  const model = options.model ?? (
    mode === "tool"
      ? process.env.GEMINI2_MODEL ?? "gemini-flash-lite-latest"
      : process.env.GEMINI1_MODEL ?? "gemini-flash-lite-latest"
  );

  const modeKey = mode === "tool" ? "gemini2" : "gemini1";
  const attempts = keys.length || 1;
  let lastError: unknown;

  for (let attempt = 0; attempt < attempts; attempt++) {
    const key = keys.length
      ? keys[keyState[modeKey] % keys.length]
      : fallbackKey!;

    try {
      const ai = new GoogleGenAI({ apiKey: key });
      const response = await ai.interactions.create({
        model,
        input: request_body as never,
        tools: options.tools ?? [],
        ...(mode === "tool" ? { generation_config: { tool_choice: "any" } } : {}),
        store: false,
      });

      if (mode === "tool") {
        return (response.steps ?? [])
          .filter((step: any) => step.type === "function_call")
          .map((step: any) => ({
            id: step.id ?? "",
            name: step.name ?? "",
            args: step.arguments ?? {},
          }));
      }

      return response.output_text ?? "";
    } catch (error) {
      lastError = error;
      if (!is429(error) || !keys.length) throw error;
      rotateKey(modeKey, keys.length);
    }
  }

  throw lastError;
}
