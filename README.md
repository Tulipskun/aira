# aira

Discord AI roleplay/chatbot pipeline using Gemini, SQLite, Chroma and local emotion images.

## Runtime flow

```text
Discord
  -> command filter + channel lock
  -> per-session scheduler (5s debounce / 12s max)
  -> Embedding 2
  -> Chroma memory + episodic search
  -> SQLite history + relationship/profile
  -> Gemini 1 (user-facing response)
  -> Gemini 2 (state/relationship analyzer)
  -> SQLite state update + local image selection
  -> Discord reply
  -> background Chroma memory/episode ingestion
```

Gemini 2 is awaited before the Discord reply because its state analysis and emotion-image selection are part of the response result. Chroma writes for new memories and episodes happen after the response path and cannot fail an otherwise successful turn.

Thought signatures required by the Gemini context protocol are kept in a process-local cache of at most 5 real signatures. The cache is persisted only after inactivity or graceful shutdown rather than on every mutation.

## Relationship state

SQLite is the source of truth for relationship state. XP is intentionally unbounded for leaderboard ranking. The ladder uses XP for the normal rungs; `crush` additionally requires at least 500 XP and the required accepted flirt history. An accepted flirt increments the flirt counter and grants an explicit XP bonus.

## Discord commands

`!islacomehere` and `!unset` are owner-only. `!islacomehere` locks the AI to the current channel; `!unset` removes the lock. The channel configuration persists in `.aira/discord-config.json` across restart.

Unknown `!` commands are ignored and do not enter the AI pipeline. Normal messages from channels other than the configured channel are ignored.

## Storage

- SQLite: conversation history and structured relationship/profile state.
- Chroma: long-term semantic and episodic memory.
- `images/`: bundled emotion assets selected by filename.
- `.aira/`: persistent runtime configuration and local service state; not committed.

Memory timestamps distinguish the source event time from the record creation time. Episodes also retain participant IDs so group-session memories do not lose identity context.

## Setup

Copy `.env.example` to `.env` and fill in `ISLA_TOKEN` (the bot's Discord token), owner ID, and Gemini API key(s). Gemini 1 defaults to `gemini-3.1-flash-lite` and Gemini 2 defaults to `gemini-3.5-flash-lite`; both can still be overridden with `.env`.

`aira start` automatically checks for the private Chroma environment. If Python 3 is missing, Aira installs it using a supported system package manager (`apt-get`, `dnf`, `pacman`, or `brew`), creates `.aira/chroma-venv`, and installs Chroma there. Existing installations are reused. Chroma data stays in `.aira/chroma/`.

```bash
bun install
bun run typecheck
bun run install-cli
aira start
```

## CLI

The CLI controls the existing supervisor and can be called from any directory after installation.

```text
aira start
aira stop
aira restart
aira status
aira log
aira logs
```

All commands return to the shell. `log` and `logs` print the last 100 lines instead of following the log stream.

See `docs/` for component contracts and architecture details.
