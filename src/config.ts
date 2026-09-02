export const config = {
  models: {
    gemini1: process.env.GEMINI1_MODEL ?? "gemini-flash-lite-latest",
    gemini2: process.env.GEMINI2_MODEL ?? "gemini-flash-lite-latest",
    embedding2: process.env.GEMINI_EMBEDDING2_MODEL ?? "gemini-embedding-2",
  },
  embedding: {
    dimension: Number(process.env.GEMINI_EMBEDDING2_DIMENSION ?? 768),
  },
  memory: {
    /**
     * How many memories to ask Chroma for, and the cosine floor for keeping one.
     *
     * `nResults` alone was the bug: a fixed top-8 always returned 8 items while the collection held
     * 6, so Isla was handed other people's romance as if it were her own past with the person in
     * front of her. Measured on the live collection: genuinely relevant pairs score 0.63–0.81 and
     * unrelated ones 0.32–0.49, so 0.60 sits in the empty gap rather than on either side.
     *
     * `ISLA_MEMORY_MIN_SIMILARITY=0` restores the old always-return-8 behaviour.
     */
    maxResults: Number(process.env.ISLA_MEMORY_MAX_RESULTS ?? 8),
    minSimilarity: Number(process.env.ISLA_MEMORY_MIN_SIMILARITY ?? 0.6),
    /** Above this, a new memory is a restatement of one already stored and is not written again. */
    dedupeSimilarity: Number(process.env.ISLA_MEMORY_DEDUPE_SIMILARITY ?? 0.92),
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
    // Gemini 2's instruction as a template: prose with {{placeholders}} filled from the code that owns
    // each number (see gemini/prompt-template.ts + gemini2PromptValues()). Re-read per request and
    // cached by mtime, so editing it needs no restart — unlike Gemini 1's, which is read once at boot.
    gemini2SystemPrompt: process.env.GEMINI2_SYSTEM_PROMPT_FILE ?? "./src/gemini/prompts/isla-state.md",
    geminiPayloadDump: process.env.GEMINI_DEBUG_PAYLOAD_FILE ?? ".aira/logs/gemini-payload.jsonl",
    // Isla's expression images. The directory *is* the enum offered to Gemini 2, so adding a
    // picture needs no code change. Relative paths resolve from the project root (see bot/images.ts).
    images: process.env.ISLA_IMAGES_DIR ?? "./images",
  },
};
