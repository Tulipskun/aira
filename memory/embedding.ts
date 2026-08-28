import { GoogleGenAI } from "@google/genai";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const MODEL = process.env.GEMINI_EMBEDDING2_MODEL ?? "gemini-embedding-2";
const DIMENSION = Number(process.env.GEMINI_EMBEDDING2_DIMENSION ?? 768);
const STATE_FILE = process.env.GEMINI_KEY_STATE_FILE ?? ".gemini-key-state.json";

type State = { embedding2: number };

function keys(): string[] {
  return (process.env.GEMINI_EMBEDDING2_API_KEYS ?? "").split(",").map((v) => v.trim()).filter(Boolean);
}

function loadState(): State {
  if (!existsSync(STATE_FILE)) return { embedding2: 0 };
  try {
    const value = JSON.parse(readFileSync(STATE_FILE, "utf8"));
    return { embedding2: Number.isInteger(value.embedding2) ? value.embedding2 : 0 };
  } catch {
    return { embedding2: 0 };
  }
}

const state = loadState();

function saveState(): void {
  writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`);
}

function status(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const value = error as { status?: number; code?: number; response?: { status?: number } };
  return value.status ?? value.code ?? value.response?.status;
}

export async function embed(text: string): Promise<number[]> {
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
        contents: text,
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
