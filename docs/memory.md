# Memory

Aira stores conversation history, semantic memories and episodic memories in the same SQLite database at .aira/aira.db. There is no external vector database or native SQLite extension.

## Semantic memory

Incoming user text (or a short attachment description for media-only turns) is embedded with Gemini. The vector and its metadata are stored in semantic_memories. Retrieval compares query and stored vectors with cosine similarity in Python and filters by both the Discord channel and character namespace. Every character, including Isla, has a separate namespace; one character never retrieves another character's semantic memories. User profile facts remain in the existing user-profile system and are supplied to Isla's relationship-aware pipeline.

Background ingestion embeds the proposed memory as a document, checks for a near-duplicate in the same session and stores it. Failures are logged and do not roll back a successful Discord response.

## Episodic memory

Episodes are built from recent SQLite turn summaries, filtered by the character that created each summary. They store text, character-scoped session, local date/period, start/end timestamps, participant IDs and embedding vectors in episodic_memories. Temporal words such as “yesterday”, “last night” and “this morning” add date/period filters to recall.

## Legacy Chroma import

On startup, Aira attempts a one-time import from .aira/chroma/ when the old Chroma Python package is still available. Imported vectors retain their IDs and metadata; the legacy files are not deleted. If Chroma is not installed, migration is deferred and a warning is logged. Do not remove the legacy directory until migration is verified or its data is intentionally retired.

Each character also stores directed relationship notes about other characters (A's view of B is independent from B's view of A). The shared room transcript remains visible to every character; only long-term semantic/episodic recall is isolated. The approved v0.4.0 first-start reset clears all pre-release memories and relationship records rather than migrating them.

The memory list and clear operations include semantic and episodic records. User-filtered deletion removes semantic records belonging to that user and episodes listing that user as a participant.


## Fresh-memory release reset

The approved fresh-memory release performs a one-time reset before any legacy Chroma import or memory migration. It clears messages, user profiles/facts, all character relationship records, turn-state idempotency rows, semantic memories and episodic memories; it also removes legacy Chroma files and Gemini thought-signature carry-over. Credentials, owner identity, API keys, model settings and channel configuration remain intact. The .aira/fresh-memory-v1 marker prevents later restarts from clearing memories created after deployment.
