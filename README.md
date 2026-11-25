# aira

Discord AI roleplay/chatbot pipeline built around Gemini, SQLite, Chroma, and local emotion images.

## Architecture

Aira separates the response path from background memory persistence. SQLite is the source of truth for conversation history and structured user state. Chroma is the semantic and episodic memory store. Gemini 1 produces the user-facing response; Gemini 2 analyzes the completed turn and produces structured state signals used by the response pipeline.

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
       -> Gemini 1 response + summary -> SQLite history
       -> Gemini 2: post-response state analysis
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

### Hybrid multi-character conversations

Aira uses one Discord bot and one response channel for all characters. Isla remains the default and always runs through the existing relationship-aware pipeline. When more character definitions are present in `characters/*.json`, a Gemini 2 router may select at most one additional character per user turn. Directly mentioning a character by its configured name or alias forces that character to join.

All selected characters see the shared SQLite conversation history, so an additional character can react to Isla's response in the same turn. Each non-Isla character has its own Chroma memory namespace and its own SQLite relationship row per Discord user. Character replies are sent as separately named embeds. Bot-authored messages are ignored by the gateway, so characters cannot recursively trigger one another indefinitely.

To add a character, create a JSON definition and its prompt file under `characters/`; see [characters/README.md](characters/README.md). Restart Aira after adding or editing character definitions.

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

Gemini 2 is an analyzer, not the user-facing dialogue model. It receives the current turn, Gemini 1's response, the turn summary, and the relevant current state, then returns structured state information such as affinity, flirt detection, approvals, facts, nicknames, memory text, and emotion-image selection.

The Gemini 2 analysis is awaited before the Discord reply because its state result and selected emotion image are part of the response result. Chroma writes are not part of the structured SQLite state transaction.

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
| SQLite | Conversation history, user profiles, Isla relationship state, per-character relationship state, XP, flirt/approval state, facts, nicknames, and episode source history |
| Chroma | Long-term semantic memory and episodic memory vectors |
| `images/` | Bundled local emotion assets selected by filename |
| `.aira/` | Persistent runtime configuration, Chroma environment/data, and local service state; not committed |

SQLite is authoritative for structured state. Chroma is an auxiliary long-term memory index and is not part of the atomic response-state transaction.

## Development and runtime separation

The development checkout and the runtime installation are intentionally separate:

- `/root/aira` — development checkout. Edit code here, run tests, then commit and push to GitHub.
- `~/.local/share/aira` — runtime checkout. Do not edit source files here.

The installed `aira` CLI operates on the runtime checkout. After a development commit is pushed, run `aira update`; it pulls the new commit, runs `bun install --frozen-lockfile` when the revision changes, registers Discord commands, and restarts Aira if it was running. Runtime `.env` and `.aira/` are preserved because they are local and ignored by Git.

Recommended workflow:

```bash
cd /root/aira
bun run typecheck
bun run test:cli
git add .
git commit -m "describe the change"
git push

# deploy to runtime
aira update
```

## One-command install and start

Aira can be installed and started with one command. Set the Discord bot token, then run the public installer:

```bash
export DISCORD=YOUR_DISCORD_BOT_TOKEN
curl -fsSL https://github.com/Tulipskun/aira/raw/refs/heads/main/install.sh | bash
```

The installer downloads or updates Aira in `~/.local/share/aira`, installs Bun if needed, installs locked dependencies, saves the token in `.env` with mode `0600`, and starts the bot. Existing `.aira/` settings and data are preserved. No GitHub login, npm login, `aira setup`, or separate `aira start` command is required.

When the bot connects, it posts an Aira Control Panel in the first server text channel where it can send messages. The Discord application owner can use the panel to choose the response channel and configure Gemini API keys and models. API keys are accepted through an ephemeral modal and stored in `.aira/settings.json` with restricted file permissions.

The bot must be invited to a server with View Channels, Send Messages, Read Message History, and Message Content intent enabled. A Gemini API key can be added after startup through the panel.

To run the installer again after an update, repeat the same command. It updates the existing Git checkout and starts/restarts through the supervisor. To use another installation directory, set `AIRA_INSTALL_ROOT` before running the installer.

For an already cloned checkout, run `export DISCORD=...` and then `./install.sh`.

## Development and verification

These commands are for development and verification. They are not required for a normal end-user installation.

```bash
bun install
bun run typecheck
bun run test:cli
bun run test:chroma
bun run scripts/test-turn-transaction.ts
```

The atomic turn-state regression test verifies both the first atomic application and a duplicate retry using the same `(sessionKey, userId, timestamp)` idempotency key. Relationship, XP, flirt count, facts, and nicknames must remain consistent after the retry.

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
