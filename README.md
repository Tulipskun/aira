# aira

Discord AI roleplay/chatbot pipeline built around Gemini, SQLite, Chroma, and local emotion images.

## Architecture

Aira separates the response path from background memory persistence. SQLite is the source of truth for conversation history and structured user state. Chroma is the semantic and episodic memory store. Gemini 1 produces the user-facing response; Gemini 2 analyzes the completed turn and produces structured relationship/state data used by the response pipeline.

### End-to-end turn flow

```text
Discord message
  -> command filter + channel lock
  -> per-session scheduler
       5s debounce / 12s maximum wait
  -> processMessage()
       -> load recent SQLite history
       -> prepare text/media
       -> save incoming message to SQLite history
       -> Embedding 2: query embedding
       -> Chroma semantic-memory retrieval
       -> Chroma episodic-memory retrieval
       -> load/update SQLite user profiles
       -> build Gemini 1 context
            profile + current state + history + memories + episode context + media
       -> Gemini 1: user-facing response
       -> Gemini 2: post-response state/relationship analysis
       -> applyTurnStateAtomic()
            BEGIN IMMEDIATE
              -> idempotency check
              -> relationship / XP / flirt / approvals
              -> facts / nicknames
              -> record applied turn key
            COMMIT
       -> local emotion-image selection
       -> Discord reply
       -> background ingestion
            -> Memory: Embedding 2 (document)
                 -> duplicate check
                 -> Chroma write
            -> Episode: rebuild recent episode from SQLite history
                 -> Embedding 2 (document)
                 -> Chroma write
```

The scheduler groups messages per session before the pipeline runs. A session is identified by `sessionKey`; group sessions can contain multiple speakers, while each speaker keeps a separate SQLite profile and relationship state.

## State persistence and idempotency

The response-critical structured state write is atomic. `src/sql/turn-transaction.ts` applies the state changes from one completed turn in a single SQLite transaction. Relationship level, XP, flirt count, approval flags, facts, and nicknames are committed together or not at all.

Each state application is identified by the tuple:

```text
(session_key, user_id, event_timestamp)
```

The tuple is stored in the `turn_state_applied` table in the same transaction as the profile update. If the same turn is retried, the existing key is detected and the state mutation is skipped. A duplicate retry therefore does not add XP, increment the flirt counter, consume approvals, or add duplicate facts/nicknames.

This idempotency mechanism protects the structured SQLite state only. Chroma ingestion is deliberately outside the response-critical transaction and is best-effort. Memory and episode ingestion failures are logged without turning an otherwise successful Discord response into a failed turn.

The transaction also deduplicates facts and nicknames case-insensitively and respects the configured maximum counts. Bond transitions and approval consumption are calculated from the same pre-update state before the single profile write.

## Memory architecture

Aira uses the same embedding service for retrieval and ingestion, but with different task types:

- `query`: embeds the incoming user message for retrieval.
- `document`: embeds the actual memory or episode text before storing it.

Semantic memory retrieval and episodic retrieval happen before Gemini 1 generates the response. Background memory ingestion runs after the response path. Memory ingestion performs a duplicate check before writing a new vector to Chroma.

Episodes are reconstructed from recent SQLite history, then embedded and stored as episodic memories. Episode records retain participant IDs so group-session memories preserve identity context.

Memory timestamps distinguish the source event timestamp from the record creation timestamp. This allows the system to preserve when an event actually happened while also tracking when the memory record was created.

## Gemini pipeline

Gemini 1 is the user-facing dialogue model. It receives the assembled conversation context, user profile/state, retrieved semantic memories, episodic context, and supported media information, then produces the response text and turn-level summary data used by the pipeline.

Gemini 2 is an analyzer, not the user-facing dialogue model. It receives the current turn, Gemini 1's response, the turn summary, and the relevant current state, then returns structured state information such as affinity, flirt detection, approvals, facts, nicknames, and emotion-image selection.

The Gemini 2 analysis is awaited before the Discord reply because its state result is part of the response result. Chroma writes are not awaited as part of the response-critical state transaction.

Thought signatures required by the Gemini context protocol are kept in a process-local cache of at most 5 real signatures. The cache is persisted only after inactivity or graceful shutdown rather than after every mutation.

## Relationship state

SQLite is the source of truth for relationship state.

XP is intentionally unbounded so it can be used for leaderboard ranking. Normal relationship progression uses the configured XP ladder. `crush` additionally requires the configured minimum XP and the required accepted flirt history. A successful flirt event increments the flirt counter and grants the explicit flirt XP bonus.

Approval-based transitions are handled by the state derivation logic. Relationship, XP, flirt count, approval flags, facts, and nicknames are persisted atomically for the turn that produced them.

## Discord behavior

`!islacomehere` and `!unset` are owner-only commands.

- `!islacomehere` locks Aira to the current channel.
- `!unset` removes the channel lock.
- The channel configuration persists in `.aira/discord-config.json` across restart.
- Unknown `!` commands are ignored and do not enter the AI pipeline.
- Normal messages from channels other than the configured channel are ignored.

Group sessions use `/isla join-group` and share conversation history and semantic/episodic context for the session, while user profiles, facts, nicknames, and relationship state remain separated by user ID.

## Storage

| Store | Responsibility |
| --- | --- |
| SQLite | Conversation history, user profiles, relationship state, XP, flirt/approval state, facts, nicknames, and episode source history |
| Chroma | Long-term semantic memory and episodic memory vectors |
| `images/` | Bundled local emotion assets selected by filename |
| `.aira/` | Persistent runtime configuration, Chroma environment/data, and local service state; not committed |

SQLite is authoritative for structured state. Chroma is an auxiliary long-term memory index and is not part of the atomic response-state transaction.

## Installation

The recommended installation is a single bootstrap command:

```bash
curl -fsSL https://raw.githubusercontent.com/Tulipskun/aira/main/install.sh | bash
```

The installer prepares Bun when needed, downloads Aira into `~/.local/share/aira`, installs dependencies, creates `.env` from `.env.example`, and installs the `aira` command into an existing writable directory already present in `PATH` whenever possible. This normally requires no `source ~/.bashrc`.

After installation, run the interactive setup instead of editing `.env` manually:

```bash
aira setup
```

Setup asks for the Discord token, owner ID, and Gemini API key(s). Multiple API keys can be entered as a comma-separated list; surrounding whitespace is trimmed automatically. Existing values are kept when you press Enter. Token and API-key input is hidden in an interactive terminal.

Model names are optional. Answer `y` to `ต้องการตั้ง model name หรือไม่ (y/N default=N)` to configure the Gemini 1, Gemini 2, and Gemini Embedding 2 model names. The default is to keep the existing/default model configuration.

Then start Aira:

```bash
aira start
```

If the installer cannot find a writable directory already in `PATH`, it falls back to `~/.local/bin`, updates the appropriate shell startup file, and prints the required `source` command.

For development or an existing checkout, manual installation remains available:

```bash
bun install
bun run install-cli
cp .env.example .env
# Edit .env
aira start
```

`aira start` automatically checks for the private Chroma environment. If Python 3 is missing, Aira installs it using a supported system package manager (`apt-get`, `dnf`, `pacman`, or `brew`), creates `.aira/chroma-venv`, and installs Chroma there. Existing installations are reused. Chroma data stays in `.aira/chroma/`.

## Development and verification

These commands are for development and verification. They are not required for a normal end-user installation.

```bash
bun install
bun run typecheck
bun run test:cli
bun run test:chroma
```

The atomic turn-state regression test can also be run directly:

```bash
bun run scripts/test-turn-transaction.ts
```

The test verifies both the first atomic application and a duplicate retry using the same `(sessionKey, userId, timestamp)` idempotency key. Relationship, XP, flirt count, facts, and nicknames must remain consistent after the retry.

Other focused regression suites include relationship-state, private-footer, episodic-memory, session, Gemini API-key configuration, CLI, and Chroma setup tests. The repository's CI runs the standard typecheck and test suites on changes to the main codebase.

## CLI

The CLI controls the existing supervisor and can be called from any directory after installation.

```text
aira setup
aira start
aira stop
aira restart
aira status
aira log
aira logs
```

All commands return to the shell. `log` and `logs` print the last 100 lines instead of following the log stream.

## Documentation

Detailed component contracts are maintained under `docs/`:

- `docs/architecture.md` — overall architecture and component boundaries.
- `docs/pipeline.md` — turn-processing pipeline and response flow.
- `docs/memory.md` — semantic and episodic memory behavior.
- `docs/sql.md` — SQLite storage and structured state.
- `docs/gemini.md` — Gemini integration and context handling.
- `docs/discord.md` — Discord commands and channel/session behavior.
- `docs/scheduler.md` — per-session scheduling and debounce behavior.

The README describes the current system at a high level; the component documents are the detailed contracts for individual subsystems.
