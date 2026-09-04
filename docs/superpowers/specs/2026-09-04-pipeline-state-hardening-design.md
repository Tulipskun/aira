# Pipeline & State Hardening Design

## Goal

Fix the identified state, persistence, latency, relationship, timestamp, documentation, and pipeline-boundary issues without changing the intentional cross-session scheduler interruption behavior.

## Decisions

1. Keep `interruptOtherSessions()` because cross-session interruption is intentional latency behavior.
2. Separate relationship/state mutation from Chroma/Gemini embedding side effects so external memory failure cannot fail the main turn.
3. Keep thought signatures primarily in memory. Keep only 5 signatures maximum, deduplicate them, and persist only on idle timeout or graceful shutdown. Runtime inactivity timeout is configurable and defaults to 10 minutes.
4. Do not rotate API keys for 5xx responses. Existing 429/401/403 behavior remains unchanged.
5. XP is unbounded and remains suitable for leaderboard ranking.
6. Relationship ladder changes `crush` to require `xp >= 500` plus the romantic-action condition. Flirting grants an explicit XP bonus in addition to incrementing the flirt counter.
7. SQLite state updates are grouped into a transaction where multiple related rows must change together. External services are never part of that transaction.
8. State invariants are explicit: XP is finite integer state but not clamped; counters are non-negative integers; primary relationship values are validated against the known set.
9. Distinguish `eventTimestamp` (when the user/event occurred) from `createdAt` (when a persisted fact/memory/episode record was created).
10. Refactor pipeline responsibilities into clear stages without changing user-visible ordering unless needed for latency.
11. README and architecture docs must describe the current JSON-based Gemini 2 analyzer flow and current memory flow, not the retired execute-tool architecture.
12. Retired execute-tool vocabulary is removed only after the implementation changes are complete.
13. Remove unused CLI constants/import-level state where safe.
14. `applyState()` becomes local structured-state application only; memory ingestion is a separate best-effort operation.
15. Discord response is sent before background Chroma memory ingestion. Memory ingestion failures are logged and do not change the successful user response.

## Non-goals

- Do not change cross-session scheduler interruption.
- Do not change 5xx key-rotation behavior.
- Do not clamp XP.
- Do not reintroduce Gemini 2 as the user-facing response generator.
- Do not reintroduce the retired execute tool protocol.

## Acceptance criteria

- Main Discord response does not wait for Chroma memory ingestion.
- Chroma/embedding failure cannot turn a successful Gemini response into a failed turn.
- Thought-signature pool contains at most 5 real signatures and does not write the persistence file on every add/invalidate.
- Signature state is flushed after configured inactivity and during graceful process shutdown.
- Relationship updates and related SQLite rows are atomic where they belong to the same turn-state mutation.
- Crush requires the new XP threshold and romantic condition; flirt contributes bonus XP.
- Timestamps have unambiguous event/creation semantics.
- Pipeline modules have clear stage boundaries.
- README/docs match implementation.
- Existing CI remains green and expanded tests cover the changed behavior.
