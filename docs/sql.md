# SQLite storage

SQLite is the source of truth for conversation history and structured user state.

## Tables

- `messages`: user/model messages, timestamps, file names, summaries and session keys.
- `user_profiles`: display names, nicknames, relationship bond, XP, flirt count, pending approvals and confirmed facts.
- `group_sessions`: per-user membership in a shared channel session.
- `character_relationships`: independent relationship description per non-Isla character and user.
- `turn_state_applied`: idempotency keys for state updates.

The runtime opens the configured `SQLITE_PATH` (default `.aira/aira.db`), applies additive schema migrations and backfills missing session keys. Existing profile/history data is retained. Legacy relationship rows are migrated into `user_profiles` only when needed.

Relationship state, approvals, fact changes and nicknames are written atomically using `BEGIN IMMEDIATE`. The event key `(session_key, user_id, event_timestamp)` prevents a retried turn from awarding XP or applying the same facts twice. Chroma ingestion is intentionally outside this SQLite transaction.

The admin CLI supports filtered listing and dry-run deletion. A deletion is executed only with `--yes`; the CLI does not create an automatic backup.
