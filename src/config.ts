export const config = {
  models: {
    gemini1: process.env.GEMINI1_MODEL ?? "gemini-flash-lite-latest",
    gemini2: process.env.GEMINI2_MODEL ?? "gemini-flash-lite-latest",
    embedding2: process.env.GEMINI_EMBEDDING2_MODEL ?? "gemini-embedding-2",
  },
  embedding: {
    dimension: Number(process.env.GEMINI_EMBEDDING2_DIMENSION ?? 768),
  },
  paths: {
    geminiKeyState: process.env.GEMINI_KEY_STATE_FILE ?? ".aira/gemini-key-state.json",
    gemini1SystemPrompt: process.env.GEMINI1_SYSTEM_PROMPT_FILE ?? "./src/gemini/prompts/isla.md",
  },
};
