# aira

Discord AI roleplay/chatbot pipeline using Gemini, SQLite, Chroma and local emotion images.

## Runtime flow

```text
Discord
  -> command filter + channel lock
  -> per-user scheduler (5s debounce / 12s max)
  -> Embedding 2
  -> Chroma memory search
  -> SQLite history + relationship
  -> Gemini 1
  -> Gemini 2
  -> forced execute parser
  -> SQLite / local image selection
  -> Discord reply
  -> optional background memory ingestion
```

Gemini 2 is awaited before the Discord reply because its relationship/state output and emotion-image selection can be required for the final response.

## Discord commands

`!islacomehere` and `!unset` are owner-only. `!islacomehere` locks the AI to the current channel; `!unset` removes the lock. The channel configuration persists in `data/discord-config.json` across restart.

Unknown `!` commands are ignored and do not enter the AI pipeline. Normal messages from channels other than the configured channel are ignored.

## Storage

- SQLite: conversation history and structured relationship/state.
- Chroma: long-term semantic memory.
- `images/`: bundled emotion assets selected by filename.
- `data/`: persistent runtime configuration; not committed.

## Setup

Copy `.env.example` to `.env` and fill in the Discord token, owner ID, Gemini models/keys, and service endpoints.

```bash
bun install
bun run typecheck
bun run start
```

See `docs/` for component contracts and architecture details.
