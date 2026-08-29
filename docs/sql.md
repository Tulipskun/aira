# SQL

SQLite (`bun:sqlite`) is the persistent store for structured application state.

## Relationship / stats

Store structured user state such as:

- `user_id` — Discord ID; stable identity
- `user_name` — current display name
- `state`
- `xp`
- `affinity`
- other relationship/stat fields required by the state system

`user_id` remains the identity when a Discord username changes.

Gemini does not receive the Discord ID.

## Conversation history

SQLite also stores conversation history so context can be reconstructed after restart.

User messages retain the application-side user ID, username, text, timestamp and optional filename. Model responses retain their role/text/timestamp. Attachment binary data is not stored here; only the filename is retained.

## Gemini 2 updates

Gemini 2 returns structured `execute` operations. The parser applies relationship/stat changes to SQLite and the resulting state can be used to build the current Discord response.

## Temporary data

Fake tool calls/results used to provide Chroma memories to Gemini are request-local and are not stored as conversation history.
