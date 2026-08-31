export const config = {
  models: {
    gemini1: process.env.GEMINI1_MODEL ?? "gemini-flash-lite-latest",
    gemini2: process.env.GEMINI2_MODEL ?? "gemini-flash-lite-latest",
    embedding2: process.env.GEMINI_EMBEDDING2_MODEL ?? "gemini-embedding-2",
  },
  embedding: {
    dimension: Number(process.env.GEMINI_EMBEDDING2_DIMENSION ?? 768),
  },
  display: {
    // Zone used to *render* timestamps for the model. Storage stays UTC regardless.
    timezone: process.env.ISLA_TIMEZONE ?? "Asia/Bangkok",
  },
  health: {
    // Loopback port scripts/supervisor.ts polls to decide whether to restart the bot. Namespaced
    // ISLA_* because this host exports unrelated env vars into every shell (see DISCORD_TOKEN).
    port: Number(process.env.ISLA_HEALTH_PORT ?? 8091),
  },
  paths: {
    geminiKeyState: process.env.GEMINI_KEY_STATE_FILE ?? ".aira/gemini-key-state.json",
    geminiThoughtSignatures: process.env.GEMINI_THOUGHT_SIGNATURE_FILE ?? ".aira/gemini-thought-signatures.json",
    gemini1SystemPrompt: process.env.GEMINI1_SYSTEM_PROMPT_FILE ?? "./src/gemini/prompts/isla.md",
    geminiPayloadDump: process.env.GEMINI_DEBUG_PAYLOAD_FILE ?? ".aira/logs/gemini-payload.jsonl",
    // Isla's expression images. The directory *is* the enum offered to Gemini 2, so adding a
    // picture needs no code change. Relative paths resolve from the project root (see bot/images.ts).
    images: process.env.ISLA_IMAGES_DIR ?? "./images",
  },
};
