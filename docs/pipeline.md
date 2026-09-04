# AI Pipeline

`src/pipeline/pipeline.ts` processes one scheduled Discord batch.

## Request path

1. Read the last 50 messages from this session's SQLite history.
2. Prepare any media once for both Gemini stages.
3. Persist the incoming user message to SQLite.
4. Embed the current input with Embedding 2.
5. Recall semantic memories and episodic memories from Chroma for the same session.
6. Load each speaker's SQLite profile and build the private/group identity block.
7. Build Gemini 1's request, including the temporary fake `search_memory(username)` result.
8. Gemini 1 produces the user-facing response JSON.
9. Persist Gemini 1's response and summary to SQLite.
10. Gemini 2 receives the user transcript, Isla's response, summary, and the owner's current state.
11. Gemini 2 returns state signals only: affinity, flirt/approval signals, facts, nickname updates,
    memory text and image selection. It does not choose a relationship rung.
12. `applyTurnState()` derives and writes the structured relationship state to SQLite.
13. Resolve the selected emotion image and build the response status from the post-turn profile.
14. Return the response to the Discord handler.
15. Discord sends the response.
16. Memory and episodic Chroma ingestion continues in background and is best-effort.

The synchronous response path therefore ends after Gemini 2 and local SQLite state application. New
Chroma writes are never allowed to delay or invalidate an otherwise successful Discord response.

## Gemini 1

Gemini 1 is the user-facing stage. Its system prompt comes from `GEMINI1_SYSTEM_PROMPT_FILE` and is
combined with the current user/group identity block and current time.

Relevant memories are represented by a temporary fake `search_memory(username)` call/result. This is a
request-local representation and is not persisted as conversation history.

## Gemini 2

Gemini 2 is an analyzer/state stage. It receives Gemini 1's completed response and returns a flat JSON
state object. The application, not the model, derives the relationship rung from XP and the reported
signals.

Gemini 2 is awaited because its state and selected emotion image can affect the final Discord response.
It is not the user-facing response generator.

## Relationship

XP is intentionally unbounded because it is also the leaderboard score. Normal ladder thresholds are
handled in `src/sql/bonds.ts`. `crush` requires at least 500 XP plus the accepted flirt requirement.
Each accepted flirt also grants a separate XP bonus.

## Memory timing

A memory has two distinct timestamps:

- `eventTimestamp`: when the source event happened.
- `createdAt`: when the memory record was created in the persistence layer.

Facts retain their source event timestamp. Chroma semantic memories and episodic records additionally
store their creation timestamp. Episodes also retain the participating user IDs for group sessions.
