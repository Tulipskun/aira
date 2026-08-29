# Architecture

## Main flow

```text
Discord
  -> bot.ts
  -> command filter + channel lock
  -> MessageScheduler
  -> pipeline.ts
  -> Gemini Embedding 2
  -> Chroma similarity search
  -> SQLite history + relationship + profile
  -> Gemini 1
  -> Gemini 2 (must wait for Gemini 1)
  -> execute
  -> SQLite relationship/profile + Chroma memory
  -> select_image(filename)
  -> local images/<filename>
  -> Discord Embed
```

Gemini Embedding 2 generates vectors for Chroma retrieval and long-term memory ingestion. Chroma is only the vector database.

Chroma runs as a separate local server. The server is started by the Bun supervisor and persists its data at `.aira/chroma/`. Aira connects to it through `CHROMA_URL` (normally `http://127.0.0.1:8000`).

The Chroma Python environment is separate from application data. By default the supervisor uses `.aira/chroma-venv/bin/chroma` when present; the venv itself should not be treated as Chroma database storage.

Gemini 2 is part of the response path. The bot does not reply until Gemini 2 has returned because relationship/state changes and `select_image` may be required to build the final response.

Only work that is not required for the current response may run afterward, such as embedding and persisting newly ingested long-term memory.

## Supervisor

`bun start` runs `scripts/supervisor.ts`.

The supervisor:

1. starts the local Chroma server on `127.0.0.1:8000`;
2. waits for `/api/v2/heartbeat` to become ready;
3. starts `bot.ts` only after Chroma is ready;
4. stops both child processes on shutdown;
5. stops Aira if Chroma exits unexpectedly.

This is designed for the Android/Debian chroot environment and does not require Docker.

## Data stores

All application runtime data belongs under `.aira/` by default:

- `.aira/aira.db` — SQLite conversation history, relationship and profile data.
- `.aira/discord-config.json` — persistent Discord channel lock.
- `.aira/gemini-key-state.json` — Gemini Embedding 2 key rotation state.
- `.aira/chroma/` — persistent Chroma storage.

`.aira/` is ignored by Git and must never be committed.

## Multi-user input

The scheduler batches messages per Discord `userId`. The pipeline receives the batch as application data and formats author names/timestamps for Gemini. Discord IDs remain internal and are never sent to Gemini.

## Image flow

`select_image` returns a filename, not a URL. `images.ts` validates it against the bundled image registry and resolves `./images/<filename>`. No runtime fetch from the legacy repository is used.

## Commands and channel lock

Messages beginning with `!` never enter the AI pipeline. Registered commands are owner-only.

- `!islacomehere`: locks the AI channel to the current Discord channel.
- `!unset`: removes the channel lock.

The channel lock persists across restart. Normal messages from other channels are ignored.
