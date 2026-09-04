# Gemini

Gemini 1 and Gemini 2 are separate model roles and use separate API-key pools.

## Gemini 1

Gemini 1 is the user-facing dialogue model. Its system instruction is assembled from
`GEMINI1_SYSTEM_PROMPT_FILE`, the current user/group profile block, and current time.

Relevant Chroma memories are represented as a temporary fake `search_memory(username)` call/result.
That representation exists only in the current request and is never persisted as history.

## Gemini 2

Gemini 2 is an analyzer/state model. It runs after Gemini 1 and receives Gemini 1's completed response.
It returns one flat JSON object containing state signals such as:

- `affinity`
- `is_flirt`
- relationship approval flags
- `select_image`
- `add_facts`
- `add_nicknames`
- `ingest_memory`

Gemini 2 does not choose the relationship rung. The application derives the rung from SQLite state and
these signals. `crush` requires at least 500 XP plus the accepted flirt requirement; an accepted flirt
also gives a separate XP bonus.

Gemini 2 remains on the response path because its state and emotion-image selection can affect the
final Discord message. New Chroma memory/episode writes are not on that critical path.

## Thought signatures

The temporary Gemini context protocol uses real thought signatures harvested from Gemini 2. At most 5
real signatures are kept in process memory and selected round-robin. The cache is persisted only after
inactivity or graceful shutdown. Disk persistence is best-effort and is never performed for every
add/invalidate operation.
