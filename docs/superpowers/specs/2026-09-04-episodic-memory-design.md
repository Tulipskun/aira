# Episodic Memory Design

## Goal
Add a temporal/episodic memory layer to Aira without replacing conversation history, structured facts, or the existing semantic memory.

## Architecture
`messages` remains the raw source of truth and keeps Gemini 1's one-line `summary` as turn-level metadata. A new `aira_episodes` Chroma collection stores compact episode summaries with session, date, time-period, start/end timestamps, and topic metadata. Episodes are built from recent model-turn summaries after each completed turn and are recalled alongside existing semantic memories.

## Memory roles
- SQLite `messages`: complete conversation history.
- SQLite `messages.summary`: one-turn recap from Gemini 1; not a long-term memory by itself.
- SQLite `user_profiles`: durable facts, nicknames, and relationship state.
- Chroma `aira_memories`: existing semantic long-term memories, including analyzer-selected facts/events.
- Chroma `aira_episodes`: temporal memories describing what happened during a bounded conversation episode.

## Episode boundaries
An episode belongs to one session and one local calendar date. A new episode starts when there is no prior model turn for the same session/date-period, or when the gap from the previous turn exceeds 30 minutes. Local periods are `morning` (05:00-11:59), `afternoon` (12:00-16:59), `evening` (17:00-21:59), and `night` (22:00-04:59), using `ISLA_TIMEZONE`.

## Episode contents
An episode is generated deterministically from the ordered turn summaries available in SQLite. Empty summaries are ignored. The stored document is a concise joined summary with the period and date context. The episode id is deterministic for `(sessionKey,startTime)` so extending an active episode changes its end time while keeping the same Chroma id and therefore upserting instead of duplicating.

## Retrieval
Existing semantic memory recall remains unchanged. Episode recall searches `aira_episodes` by embedding and session scope, with a configurable similarity floor. When the user query contains an explicit temporal phrase such as `เมื่อเช้า`, `ตอนเช้า`, `วันนี้`, `เมื่อวาน`, `ตอนบ่าย`, `ตอนเย็น`, or `เมื่อคืน`, the episode query additionally applies the corresponding local date/period metadata filter. Returned episodes are injected into the same synthetic `search_memory` result as existing memories, but with `type=episodic` metadata so Gemini 1 can distinguish them from durable memories.

## Retention
Episodes are not facts and should not be copied into `user_profiles`. They remain in Chroma until normal memory maintenance removes them. Duplicate writes are prevented by deterministic ids/upsert.

## Compatibility
The existing `summery` field/output from Gemini 1 remains unchanged. No Gemini schema change is required. Existing `aira_memories` behavior and thresholds remain intact.

## Configuration
Add:
- `ISLA_EPISODE_COLLECTION` default `aira_episodes`
- `ISLA_EPISODE_MAX_RESULTS` default `5`
- `ISLA_EPISODE_MIN_SIMILARITY` default `0.55`
- `ISLA_EPISODE_GAP_MINUTES` default `30`

## Testing
Add focused tests for period classification, episode boundary detection, deterministic ids, temporal query parsing, and filtering/formatting. Run TypeScript typecheck and the episode tests.
