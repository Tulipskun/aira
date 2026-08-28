import { GoogleGenAI } from "@google/genai";

export type Content =
  | { type: "text"; text: string }
  | { type: "function_call"; id: string; name: string; args: Record<string, unknown> }
  | { type: "function_result"; call_id: string; name?: string; result: unknown };

export type Turn = {
  role: "user" | "model" | "tool";
  content: Content[];
};

export interface GeminiRequestOptions {
  model?: string;
  apiKey?: string;
  tools?: unknown[];
  responseMode?: "text" | "tool";
}

const DEFAULT_MODEL = process.env.GEMINI_MODEL ?? "gemini-flash-lite-latest";

export function user(text: string): Turn {
  return { role: "user", content: [{ type: "text", text }] };
}

export function fakeTool(
  name: string,
  args: Record<string, unknown>,
  result: unknown
): Turn[] {
  const callId = `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  return [
    {
      role: "model",
      content: [{ type: "function_call", id: callId, name, args }],
    },
    {
      role: "tool",
      content: [{ type: "function_result", call_id: callId, name, result }],
    },
  ];
}

export function ctxWindowCreate(
  history: Turn[],
  message: string,
  temporaryTurns: Turn[] = []
): Turn[] {
  return [...history, user(message), ...temporaryTurns];
}

export async function sendRequestGemini1(
  request_body: Turn[],
  options: GeminiRequestOptions = {}
): Promise<string> {
  const ai = new GoogleGenAI({
    apiKey: options.apiKey ?? process.env.GEMINI_API_KEY,
  });

  const response = await ai.interactions.create({
    model: options.model ?? DEFAULT_MODEL,
    input: request_body as never,
    tools: options.tools ?? [],
    store: false,
  });

  return response.output_text ?? "";
}
