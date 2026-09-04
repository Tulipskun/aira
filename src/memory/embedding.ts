import { GoogleGenAI } from "@google/genai";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "../config.js";

const MODEL = config.models.embedding2;
const DIMENSION = config.embedding.dimension;
const STATE_FILE = config.paths.geminiKeyState;

type State = { embedding2: number };
export type EmbeddingTask = "query" | "document";

/**
 * Gemini Embedding 2 does not accept the legacy `taskType` API field. For text-only retrieval,
 * Google recommends expressing the task as an instruction in the input text instead.
 */
export function prepareEmbeddingInput(text: string, task: EmbeddingTask): string {
  if (task === "query") return `task: search result | query: ${text}`;
  return `title: none | text: ${text}`;
}

function keys(): string[] { return (process.env.GEMINI_EMBEDDING2_API_KEYS ?? "").split(",").map((v) => v.trim()).filter(Boolean); }
function loadState(): State {
  if (!existsSync(STATE_FILE)) return { embedding2: 0 };
  try { const value = JSON.parse(readFileSync(STATE_FILE, "utf8")); return { embedding2: Number.isInteger(value.embedding2) ? value.embedding2 : 0 }; }
  catch { return { embedding2: 0 }; }
}
const state = loadState();
function saveState(): void { mkdirSync(dirname(STATE_FILE), { recursive: true }); writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`); }
function status(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const value = error as { status?: number; code?: number; response?: { status?: number } };
  return value.status ?? value.code ?? value.response?.status;
}

export async function embed(text: string, task: EmbeddingTask = "query"): Promise<number[]> {
  const apiKeys = keys();
  const fallback = process.env.GEMINI_EMBEDDING2_API_KEY ?? process.env.GEMINI_API_KEY;
  if (!apiKeys.length && !fallback) throw new Error("No Gemini Embedding 2 API key configured");
  let attempts = 0;
  while (attempts < (apiKeys.length || 1)) {
    const key = apiKeys.length ? apiKeys[state.embedding2 % apiKeys.length] : fallback!;
    try {
      const ai = new GoogleGenAI({ apiKey: key });
      const response = await ai.models.embedContent({
        model: MODEL,
        contents: prepareEmbeddingInput(text, task),
        config: { outputDimensionality: DIMENSION },
      });
      const values = response.embeddings?.[0]?.values;
      if (!values?.length) throw new Error("Gemini Embedding 2 returned no embedding");
      return values;
    } catch (error) {
      if (status(error) !== 429 || !apiKeys.length) throw error;
      state.embedding2 = (state.embedding2 + 1) % apiKeys.length;
      saveState();
      attempts++;
    }
  }
  throw new Error("All Gemini Embedding 2 API keys were rate-limited");
}
