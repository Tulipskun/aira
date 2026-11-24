# Gemini

Gemini 1 and Gemini 2 are separate model roles. They are configured from one shared `GEMINI_API_KEY` pool, while the runtime maintains independent rotation state for each stage.

## Gemini 1

Gemini 1 is the user-facing dialogue model. Its system instruction is assembled from `GEMINI1_SYSTEM_PROMPT_FILE`, the current user/group profile block, and current time.

Relevant Chroma memories are represented as a temporary fake `search_memory(username)` call/result. That representation exists only in the current request and is never persisted as history.

Gemini 1 returns the response text and turn-level summary used by the pipeline. The response and summary are persisted to SQLite before Gemini 2 analysis.

## Gemini 2

Gemini 2 is an analyzer/state model. It runs after Gemini 1 and receives Gemini 1's completed response and summary.

It returns one flat JSON object containing state signals such as:

- `affinity`
- `is_flirt`
- relationship approval flags
- `select_image`
- `add_facts`
- `add_nicknames`
- `ingest_memory`

Gemini 2 does not choose the relationship rung. The application derives the rung from SQLite state and these signals. `crush` requires at least 500 XP plus the accepted flirt requirement; an accepted flirt also gives a separate XP bonus.

Gemini 2 remains on the response path because its state and emotion-image selection can affect the final Discord message. New Chroma memory/episode writes are not on that critical path.

## API-key rotation

`GEMINI_API_KEY` accepts one or more comma-separated keys. `src/config.ts` maps the shared pool to the internal stage-specific variables. The runtime keeps independent key-rotation state per stage, so a rate limit in one stage does not advance the rotation counter of another stage.

The stage-specific `GEMINI1_API_KEYS`, `GEMINI2_API_KEYS`, and `GEMINI_EMBEDDING2_API_KEYS` variables are internal runtime aliases and are not required in `.env` setup.

## Embedding

Gemini Embedding 2 is configured separately from the dialogue/analyzer models. Retrieval uses the `query` task and memory/episode ingestion uses the `document` task.

## Thought signatures

The temporary Gemini context protocol uses real thought signatures harvested from Gemini 2. At most 5 real signatures are kept in process memory and selected round-robin. The cache is persisted only after inactivity or graceful shutdown. Disk persistence is best-effort and is never performed for every add/invalidate operation.
