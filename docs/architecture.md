# Architecture

## Main flow

```text
Discord
  -> src/bot/bot.ts
  -> command filter + channel lock (src/bot/commands.ts)
  -> session resolution (src/sql/sessions.ts -> user:<id> | group:<channel>)
  -> MessageScheduler (src/pipeline/scheduler.ts), batching per session
  -> src/pipeline/pipeline.ts
  -> Gemini Embedding 2 (src/memory/embedding.ts)
  -> Chroma similarity search, scoped to the session (src/memory/chroma.ts)
  -> SQLite history for this session + profiles of every speaker (src/sql/)
  -> Gemini 1 (src/gemini/client.ts)
  -> Gemini 2 (must wait for Gemini 1)
  -> one flat JSON state object (no tool call)
  -> SQLite relationship/profile + Chroma memory (stamped with the session key)
  -> select_image(filename)
  -> local images/<filename>
  -> Discord Embed
```

## Model configuration

All model names are configurable from `.env` and are centralized in `config.ts`. Code should not hardcode model names in individual pipeline modules.

- `GEMINI1_MODEL` — Gemini 1 dialogue/character response model.
- `GEMINI2_MODEL` — Gemini 2 post-response decision/tool model.
- `GEMINI_EMBEDDING2_MODEL` — Gemini Embedding 2 used for Chroma queries and long-term memory vectors.
- `GEMINI_EMBEDDING2_DIMENSION` — requested embedding dimensionality.

API keys remain separate per model role: `GEMINI1_API_KEYS`, `GEMINI2_API_KEYS`, and `GEMINI_EMBEDDING2_API_KEYS`.

`GEMINI1_SYSTEM_PROMPT_FILE` points to the editable Gemini 1 character/system prompt. Default: `./src/gemini/prompts/isla.md`.

Gemini Embedding 2 generates vectors for Chroma retrieval and long-term memory ingestion. Chroma is only the vector database.

Chroma runs as a separate local server. The server is started by the Bun supervisor and persists its data at `.aira/chroma/`. Aira connects to it through `CHROMA_URL` (normally `http://127.0.0.1:8000`).

## Response ordering

Gemini 2 is part of the response path. The bot does not reply until Gemini 2 has returned because relationship/state changes and `select_image` may be required to build the final response.

Only work that is not required for the current response may run afterward, such as embedding and persisting newly ingested long-term memory.

## Supervisor

`bun start` runs `scripts/supervisor.ts`.

The supervisor starts Chroma, waits for its heartbeat, then starts Aira. It shuts down both child processes together and does not require Docker.

## Data stores

All application runtime data belongs under `.aira/` by default:

- `.aira/aira.db` — SQLite conversation history, relationship and profile data.
- `.aira/discord-config.json` — persistent Discord channel lock.
- `.aira/gemini-key-state.json` — persistent Gemini key rotation state.
- `.aira/chroma/` — persistent Chroma storage.

`.aira/` is ignored by Git and must never be committed.

## Multi-user input

The scheduler batches messages per Discord `userId`. Discord IDs remain internal and are never sent to Gemini.

## Image flow

`select_image` returns a filename, not a URL. The registry is the `images/` directory itself: its
listing (plus `manifest.json` descriptions) is what Gemini 2 is offered as the enum, and the same
listing is what a returned filename is validated against before the local file is read. Nothing is
hardcoded, so adding a picture needs no code change. `none` is a legal answer meaning "no picture
this turn".

## Commands and channel lock

Messages beginning with `!` never enter the AI pipeline. Registered commands are owner-only.

- `!islacomehere`: locks the AI channel to the current Discord channel.
- `!unset`: removes the channel lock.

The channel lock persists across restart. Normal messages from other channels are ignored.
