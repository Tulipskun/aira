# Memory

Aira stores structured conversation history in SQLite and long-term semantic/episodic vectors in Chroma.

## Semantic memory

Incoming user text (or a short attachment description for media-only turns) is embedded with the query task. Memories are retrieved only within the active session. A memory written by one private user session is not visible in another private session. Group memories are visible to members of the same group session. Additional characters use a character-specific session namespace.

Background ingestion embeds the proposed memory as a document, checks for a near-duplicate in the same session and then upserts it. Failures are logged and do not roll back a successful Discord response.

## Episodic memory

An episode is built from recent SQLite turn summaries within a time window. It stores the text, session, local date/period, start/end timestamps and participant IDs. The episode ID uses the same deterministic hash as the TypeScript implementation so an existing episode is updated rather than duplicated after migration.

Temporal words such as “yesterday”, “last night” and “this morning” add date/period filters to episodic recall.

## Chroma deployment

By default, Chroma runs embedded with persistent storage under `.aira/chroma`; a separate service is not required. If the previous TypeScript deployment used a remote Chroma server, set the same `CHROMA_URL` before switching runtimes so the existing collection data remains in place. Set `CHROMA_URL` only when pointing to that remote Chroma server. On startup, records without a `sessionKey` metadata field are assigned to the corresponding `user:<id>` session or to `legacy:unattributed` when no user ID exists.


The admin memory list and clear operations include both semantic records and episodic vectors. A user-filtered delete removes semantic records belonging to that user and episodes listing that user as a participant; a session-filtered delete removes both kinds within that session.
