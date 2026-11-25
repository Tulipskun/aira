# Architecture

## Main flow

```text
Discord
  -> src/bot/bot.ts
  -> command filter + channel lock (src/bot/commands.ts)
  -> session resolution (src/sql/sessions.ts -> user:<id> | group:<channel>)
  -> MessageScheduler (src/pipeline/scheduler.ts), batching per session
  -> src/pipeline/pipeline.ts
  -> Gemini Embedding 2 query embedding
  -> Chroma semantic + episodic retrieval, scoped to the session
  -> SQLite history + profiles for the speakers in the session
  -> Gemini 1 dialogue response + turn summary
  -> persist Gemini 1 response/summary to SQLite
  -> Gemini 2 post-response analysis
  -> one flat JSON state object (no tool call)
  -> applyTurnStateAtomic()
       BEGIN IMMEDIATE
         -> idempotency check
         -> relationship / XP / flirt / approvals
         -> facts / nicknames
         -> record applied turn key
       COMMIT
  -> select_image(filename)
  -> local images/<filename>
  -> Discord Embed
  -> background memory/episode ingestion
       -> Gemini Embedding 2 document embedding
       -> duplicate check
       -> Chroma write
```

The structured state mutation is response-critical and atomic in SQLite. Chroma ingestion is deliberately outside that transaction and is best-effort.

## Model configuration

Model names are centralized in `src/config.ts`. They can be supplied through `.env` or changed at runtime through the owner-only Discord Control Panel; panel values are persisted in `.aira/settings.json` and take effect on subsequent requests. Code should not hardcode model names in individual pipeline modules.

- `GEMINI1_MODEL` — Gemini 1 dialogue/character response model.
- `GEMINI2_MODEL` — Gemini 2 post-response analyzer/state model.
- `GEMINI_EMBEDDING2_MODEL` — Gemini Embedding 2 used for Chroma queries and long-term memory vectors.
- `GEMINI_EMBEDDING2_DIMENSION` — requested embedding dimensionality.

All Google Gemini stages are configured from one comma-separated `GEMINI_API_KEY` pool. The runtime maps that shared pool to stage-specific internal variables while retaining independent rotation state per stage. The stage-specific `*_API_KEYS` variables are internal compatibility/runtime variables and are not required for setup.

`GEMINI1_SYSTEM_PROMPT_FILE` points to the editable Gemini 1 character/system prompt. Default: `./src/gemini/prompts/isla.md`.

`GEMINI2_SYSTEM_PROMPT_FILE` points to Gemini 2's state-analysis prompt template. Default: `./src/gemini/prompts/isla-state.md`.

Gemini Embedding 2 generates vectors for Chroma retrieval and long-term memory ingestion. Chroma is only the vector database.

Chroma runs as a separate local server. The server is started by the Bun supervisor and persists its data at `.aira/chroma/`. Aira connects to it through `CHROMA_URL` (normally `http://127.0.0.1:8000`).

## Response ordering

Gemini 2 is part of the response path. The bot does not reply until Gemini 2 has returned because relationship/state changes and `select_image` may be required to build the final response.

`applyTurnStateAtomic()` commits the structured relationship/profile mutation before the response is assembled. The transaction covers relationship, XP, flirt count, approval flags, facts, nicknames, and the turn idempotency record.

Only work that is not required for the current response runs afterward, including new semantic-memory and episode Chroma writes.

## State idempotency

A turn state mutation is identified by `(session_key, user_id, event_timestamp)`. The key is recorded in `turn_state_applied` inside the same SQLite transaction as the profile mutation. Retrying the same turn therefore does not double-apply XP, flirt count, approvals, facts, or nicknames.

This protects structured SQLite state. It does not make Chroma ingestion transactional; Chroma ingestion remains asynchronous/best-effort.

## Supervisor

`bun start` runs `scripts/supervisor.ts`.

The supervisor starts Chroma, waits for its heartbeat, then starts Aira. It shuts down both child processes together and does not require Docker.

## Data stores

All application runtime data belongs under `.aira/` by default:

- `.aira/aira.db` — SQLite conversation history, relationship and profile data, and applied-turn idempotency records.
- `.aira/discord-config.json` — persistent Discord channel lock.
- `.aira/settings.json` — Gemini API keys and model names configured through the Control Panel (mode `0600`).
- `.aira/gemini-key-state.json` — persistent Gemini key rotation state.
- `.aira/chroma/` — persistent Chroma storage.

`.aira/` is ignored by Git and must never be committed. The Discord token is kept separately in `.env`, also ignored by Git and written with mode `0600`.

## Multi-user input

The scheduler batches messages per session. In a private session, the stream is `user:<id>`. In a group session, the stream is `group:<channel>`. Each speaker still has a separate SQLite profile and relationship state.

Discord IDs remain internal in private-session Gemini context. Group-session context may include speaker identity information required to attribute each message correctly.

## Image flow

`select_image` returns a filename, not a URL. The registry is the `images/` directory itself: its listing (plus `manifest.json` descriptions) is what Gemini 2 is offered as the enum, and the same listing is what a returned filename is validated against before the local file is read. Nothing is hardcoded, so adding a picture needs no code change. `none` is a legal answer meaning "no picture this turn".

## Commands and channel lock

Messages beginning with `!` never enter the AI pipeline. Registered commands are owner-only.

- `!islacomehere`: locks the AI channel to the current Discord channel.
- `!unset`: removes the channel lock.

The channel lock persists across restart. Normal messages from other channels are ignored.

## Discord Control Panel

After the Discord gateway is ready, the bot publishes or updates the `Aira • Control Panel` message in the first writable guild text channel it finds. The Discord application owner is resolved from the application metadata and is the only user authorized to interact with the panel. It manages the response channel, shared Gemini API-key pool, three model names, and character definitions/prompts. Settings are persisted in `.aira/settings.json` with restrictive file permissions. The panel's posting channel is not automatically the response channel; the owner must select the latter explicitly.
