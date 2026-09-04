# SQL

SQLite (`bun:sqlite`) is the persistent source of truth for structured application state.

## Relationship / stats

Store internal relationship state such as:

- `user_id` — Discord ID; stable identity
- `user_name` — current display name
- `state`
- `xp`
- `affinity`
- other relationship/stat fields required by the state system

`user_id` remains the identity when a Discord username changes.

These internal values are not included in the Gemini `<user_profile>` block. In particular, Discord user ID, XP and affinity must not be sent to Gemini as private-session profile data.

## User profile

`user_profiles` stores information intended to become context for Gemini 1:

- `name`
- `nicknames`
- `facts`

The application combines the profile with the relationship's human-readable state when constructing `<user_profile>`.

Example:

```xml
<user_profile>
ชื่อ: Yuuta
ความสัมพันธ์กับ Isla: คนรัก
ฉายาที่ Isla ตั้งให้: คนโปรด, คนขี้แกล้ง
fact:
- ชอบให้ไอล่าเรียกว่าที่รัก
- ชอบหมา
- เคยบอกว่าเป็นประธานบริษัท
</user_profile>
```

Gemini 2 can return fact and nickname updates. The pipeline persists those updates together with the relationship/stat changes through `applyTurnStateAtomic()`.

## Atomic turn state

`src/sql/turn-transaction.ts` is the single atomic write path for the structured state produced by a completed turn.

One SQLite transaction commits these changes together:

- relationship/bond derivation
- XP
- flirt count
- relationship approval flags
- facts
- nicknames
- the idempotency record for the turn

The transaction uses `BEGIN IMMEDIATE` and rolls back the whole mutation on failure.

The idempotency key is `(session_key, user_id, event_timestamp)` and is stored in `turn_state_applied`. A retry with the same key is detected inside the transaction and produces no second state mutation.

Chroma writes are not included in this transaction. They are background, best-effort persistence of semantic and episodic memory.

## Conversation history

SQLite also stores conversation history so context can be reconstructed after restart.

User messages retain the application-side user ID, username, text, timestamp and optional filename. Model responses retain their role/text/timestamp. Attachment binary data is not stored here; only the filename is retained.

Every row also carries `session_key` — the conversation stream it belongs to (`user:<id>` or `group:<channel>`). `getHistory(limit, sessionKey)` reads one stream, never the whole table, and `saveMessage()` requires the key at compile time so a call site cannot forget it. Rows written before session scoping were backfilled at startup from the user turn they answer; anything with no attributable author is filed under `legacy:unattributed` and is never read.

## Sessions

`group_sessions` is the membership registry for shared conversations: one row per user (`user_id`, `channel_id`, `joined_at`), written only by `/isla join-group` and `/isla leave-group`. It is deliberately a separate table rather than a column on `user_profiles` — a session is routing, not a fact about the relationship, so joining a room can never touch bond/xp/facts.

`sessionKeyFor(userId, channelId)` is the single decision point: a user who joined in channel A and writes in channel B gets their private stream, because they are not in A's room.

## Temporary data

Fake tool calls/results used to provide Chroma memories to Gemini are request-local and are not stored as conversation history.
