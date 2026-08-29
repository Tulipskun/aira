import { GoogleGenAI, type Interactions } from "@google/genai";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "../config.js";
import { addThoughtSignature, invalidateThoughtSignature, nextThoughtSignature } from "./thought-signatures.js";

export type Message = {
  role: "user" | "model";
  userId?: string;
  user?: string;
  text: string;
  timestamp: string;
  fileName?: string;
};
export type GeminiRequest = { messages: Message[]; temporary?: Interactions.Step[] };
export type FunctionCall = { id: string; name: string; args: Record<string, unknown> };
export type FakeToolResult = { name: string; args: Record<string, unknown>; result: unknown };

export interface GeminiRequestOptions {
  model?: string;
  apiKey?: string;
  tools?: Interactions.Tool[];
  responseMode?: "text" | "tool";
  systemInstruction?: string;
}

type KeyState = { gemini1: number; gemini2: number };
const STATE_FILE = config.paths.geminiKeyState;
const MAX_5XX_RETRIES = 3;
// Each retry costs one fast 400 and drains one bad signature from the pool, so a generous cap
// still converges quickly; the seed signature is the last-resort fallback once the pool empties.
const MAX_SIGNATURE_RETRIES = 8;
const BASE_BACKOFF_MS = 250;

function envKeys(name: string): string[] { return (process.env[name] ?? "").split(",").map((key) => key.trim()).filter(Boolean); }
function loadKeyState(): KeyState {
  if (!existsSync(STATE_FILE)) return { gemini1: 0, gemini2: 0 };
  try {
    const state = JSON.parse(readFileSync(STATE_FILE, "utf8"));
    return { gemini1: Number.isInteger(state.gemini1) ? state.gemini1 : 0, gemini2: Number.isInteger(state.gemini2) ? state.gemini2 : 0 };
  } catch { return { gemini1: 0, gemini2: 0 }; }
}
const keyState = loadKeyState();
function saveKeyState(): void { mkdirSync(dirname(STATE_FILE), { recursive: true }); writeFileSync(STATE_FILE, `${JSON.stringify(keyState, null, 2)}\n`); }
function rotateKey(mode: "gemini1" | "gemini2", count: number): void { keyState[mode] = (keyState[mode] + 1) % count; saveKeyState(); }
function errorStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const e = error as { status?: number; code?: number; response?: { status?: number } };
  return e.status ?? e.code ?? e.response?.status;
}
function is429(error: unknown): boolean { return errorStatus(error) === 429; }
function isRetryable5xx(error: unknown): boolean { const status = errorStatus(error); return status !== undefined && status >= 500 && status <= 599; }
// A rejected signature surfaces as one of two 400 messages depending on how malformed it is:
// "Corrupted thought signature." or "The value is invalid for 'input[N].signature'. Expected
// string, corrupt base64". Both mean "drop this signature and try another".
function isBadThoughtSignature(error: unknown): boolean {
  if (errorStatus(error) !== 400) return false;
  const message = String((error as { message?: unknown } | undefined)?.message ?? "");
  return /corrupted thought signature|\.signature'|signature[^\n]*corrupt/i.test(message);
}
function sleep(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
function backoffDelay(retry: number): number { return BASE_BACKOFF_MS * 2 ** retry + Math.floor(Math.random() * 100); }

function messageStep(message: Message): Interactions.Step {
  const metadata = {
    ...(message.role === "user" && message.user && { user: message.user }),
    text: message.text,
    timestamp: message.timestamp,
    ...(message.fileName && { file: message.fileName }),
  };
  return {
    type: message.role === "model" ? "model_output" : "user_input",
    content: [{ type: "text", text: JSON.stringify(metadata) }],
  };
}

// The Interactions API rejects a `function_call` step unless the model turn that "made" the
// call is present too: it needs a `thought` step carrying a valid `signature` right before it.
// Without it every request fails with 400 "Request contains an invalid argument."; with a
// malformed/expired one it fails with 400 "Corrupted thought signature.". Signatures are not
// bound to a payload, so they are pooled and rotated (see thought-signatures.ts): Gemini 2
// donates one on every tool call and Gemini 1 consumes them round-robin.
export function fakeToolCallResult(name: string, args: Record<string, unknown>, result: unknown): Interactions.Step[] {
  const callId = crypto.randomUUID();
  return [
    { type: "thought", signature: nextThoughtSignature() },
    { type: "function_call", id: callId, name, arguments: args },
    { type: "function_result", name, call_id: callId, result: [{ type: "text", text: JSON.stringify(result) }] },
  ];
}

// Drop the signature(s) that were just rejected and rebuild the steps with the next pool
// entries. Returns null when nothing better is available -- either there is no thought step, or
// the pool is empty and only the seed remains, which would be retried unchanged.
function rotateThoughtSignatures(temporary: Interactions.Step[]): Interactions.Step[] | null {
  const used = temporary
    .filter((step) => step.type === "thought")
    .map((step) => (step as { signature?: string }).signature);
  if (!used.length) return null;
  for (const signature of used) invalidateThoughtSignature(signature);
  const rotated = temporary.map((step) =>
    step.type === "thought" ? { ...step, signature: nextThoughtSignature() } : step,
  );
  const fresh = rotated
    .filter((step) => step.type === "thought")
    .map((step) => (step as { signature?: string }).signature);
  return fresh.some((signature, index) => signature !== used[index]) ? rotated : null;
}

export function ctxWindowCreate(messages: Message[], message: string, user: string, timestamp: string, fileName?: string, temporary: Interactions.Step[] = [], userId?: string): GeminiRequest {
  return { messages: [...messages, { role: "user", userId, user, text: message, timestamp, ...(fileName && { fileName }) }], temporary };
}

export async function sendRequestGemini(requestBody: GeminiRequest, options: GeminiRequestOptions = {}): Promise<string | FunctionCall[]> {
  const mode = options.responseMode ?? "text";
  const keys = envKeys(mode === "tool" ? "GEMINI2_API_KEYS" : "GEMINI1_API_KEYS");
  const fallbackKey = options.apiKey ?? process.env.GEMINI_API_KEY;
  if (!keys.length && !fallbackKey) throw new Error(`No API key configured for ${mode}`);
  const model = options.model ?? (mode === "tool" ? config.models.gemini2 : config.models.gemini1);
  const stateKey = mode === "tool" ? "gemini2" : "gemini1";
  let lastError: unknown;
  let serverRetries = 0;
  let keyAttempts = 0;
  let signatureAttempts = 0;
  let temporary = [...(requestBody.temporary ?? [])];

  while (keyAttempts < (keys.length || 1)) {
    const key = keys.length ? keys[keyState[stateKey] % keys.length] : fallbackKey!;
    try {
      const ai = new GoogleGenAI({ apiKey: key });
      const response = await ai.interactions.create({
        model,
        input: [...requestBody.messages.map(messageStep), ...temporary],
        tools: options.tools ?? [],
        ...(options.systemInstruction && { system_instruction: options.systemInstruction }),
        ...(mode === "tool" ? { generation_config: { tool_choice: { allowed_tools: { mode: "any" } } } } : {}),
        store: false,
      });
      if (mode === "tool") {
        for (const step of response.steps) {
          if (step.type === "thought") addThoughtSignature((step as { signature?: string }).signature);
        }
        return response.steps.filter((step) => step.type === "function_call").map((step) => ({ id: step.id, name: step.name, args: step.arguments as Record<string, unknown> }));
      }
      return response.output_text ?? "";
    } catch (error) {
      lastError = error;
      if (is429(error) && keys.length) { rotateKey(stateKey, keys.length); keyAttempts++; serverRetries = 0; continue; }
      if (isRetryable5xx(error) && serverRetries < MAX_5XX_RETRIES) { await sleep(backoffDelay(serverRetries++)); continue; }
      if (isBadThoughtSignature(error) && signatureAttempts < MAX_SIGNATURE_RETRIES) {
        const rotated = rotateThoughtSignatures(temporary);
        if (!rotated) throw error;
        temporary = rotated;
        signatureAttempts++;
        continue;
      }
      throw error;
    }
  }
  throw lastError;
}
