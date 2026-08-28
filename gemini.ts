import { GoogleGenAI } from "@google/genai";

export type Content =
  | { type: "text"; text: string }
  | { type: "function_call"; id: string; name: string; args: Record<string, unknown> }
  | { type: "function_result"; call_id: string; name?: string; result: unknown };

export type Turn = {
  role: "user" | "model" | "tool";
  content: Content[];
};

export interface GeminiOptions {
  model?: string;
  apiKey?: string;
  tools?: unknown[];
}

const DEFAULT_MODEL = process.env.GEMINI_MODEL ?? "gemini-flash-lite-latest";

export async function sendMessage(
  message: string,
  history: Turn[] = [],
  temporaryTurns: Turn[] = [],
  options: GeminiOptions = {}
): Promise<string> {
  const ai = new GoogleGenAI({
    apiKey: options.apiKey ?? process.env.GEMINI_API_KEY,
  });

  const input: Turn[] = [
    ...history,
    user(message),
    ...temporaryTurns,
  ];

  const response = await ai.interactions.create({
    model: options.model ?? DEFAULT_MODEL,
    input: input as never,
    tools: options.tools ?? [],
    store: false,
  });

  return response.output_text ?? "";
}

export function user(text: string): Turn {
  return { role: "user", content: [{ type: "text", text }] };
}

export function fakeToolCall(
  name: string,
  args: Record<string, unknown>,
  id = `call_${Date.now()}`
): Turn {
  return {
    role: "model",
    content: [{ type: "function_call", id, name, args }],
  };
}

export function fakeToolResult(
  name: string,
  result: unknown,
  callId: string
): Turn {
  return {
    role: "tool",
    content: [{ type: "function_result", call_id: callId, name, result }],
  };
}
