# aira

Discord AI roleplay/chatbot pipeline using Gemini, SQLite, Chroma and local emotion images.

## Runtime flow

```text
Discord
  -> command filter + channel lock
  -> per-session scheduler (5s debounce / 12s max)
  -> Embedding 2 (query)
  -> Chroma semantic memory search + episodic search
  -> SQLite history + relationship/profile
  -> Gemini 1 (user-facing response)
  -> Gemini 2 (state/relationship analyzer)
  -> SQLite state update + local image selection
  -> Discord reply
  -> background memory/episode ingestion
       -> Memory:  Embedding 2 (document) -> duplicate check -> Chroma
       -> Episode: build from SQLite history -> Embedding 2 (document) -> Chroma
```

Embedding 2 is used in both directions. Retrieval embeds the incoming query with the `query` task type. Background ingestion embeds the actual stored memory or episode text with the `document` task type before writing its vector to Chroma. Memory ingestion checks for a duplicate using that document vector before the write. Episode ingestion builds the recent episode from SQLite history before embedding it.

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

## Installation

The recommended installation is a single bootstrap command:

```bash
curl -fsSL https://raw.githubusercontent.com/Tulipskun/aira/main/install.sh | bash
```

The installer prepares Bun when needed, downloads Aira into `~/.local/share/aira`, installs dependencies, creates `.env` from `.env.example`, and installs the `aira` command into an existing writable directory already present in `PATH` whenever possible. This means no `source ~/.bashrc` is required for normal installations.

After installation, fill in `~/.local/share/aira/.env` with `ISLA_TOKEN`, `DISCORD_OWNER_ID`, and Gemini API key(s), then run:

```bash
aira start
```

If the installer cannot find a writable directory already in `PATH`, it falls back to `~/.local/bin`, updates the appropriate shell startup file, and prints the required `source` command.

For development or an existing checkout, the manual installation remains available:

```bash
bun install
bun run install-cli
cp .env.example .env
# Edit .env
aira start
```

`aira start` automatically checks for the private Chroma environment. If Python 3 is missing, Aira installs it using a supported system package manager (`apt-get`, `dnf`, `pacman`, or `brew`), creates `.aira/chroma-venv`, and installs Chroma there. Existing installations are reused. Chroma data stays in `.aira/chroma/`.

## Development / Verification

These commands are for development and verification. They are not required for a normal end-user installation.

```bash
bun install
bun run typecheck
bun run test:cli
bun run test:chroma
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
