# Memory

Aira stores conversation history, semantic memories and episodic memories in the same SQLite database at .aira/aira.db. There is no external vector database or native SQLite extension.

## Semantic memory

Incoming user text (or a short attachment description for media-only turns) is embedded with Gemini. The vector and its metadata are stored in semantic_memories. Retrieval compares query and stored vectors with cosine similarity in Python and filters by the active Discord channel session. Additional characters use character-specific session namespaces.

Background ingestion embeds the proposed memory as a document, checks for a near-duplicate in the same session and stores it. Failures are logged and do not roll back a successful Discord response.

## Episodic memory

Episodes are built from recent SQLite turn summaries. They store text, session, local date/period, start/end timestamps, participant IDs and embedding vectors in episodic_memories. Temporal words such as “yesterday”, “last night” and “this morning” add date/period filters to recall.

## Legacy Chroma import

On startup, Aira attempts a one-time import from .aira/chroma/ when the old Chroma Python package is still available. Imported vectors retain their IDs and metadata; the legacy files are not deleted. If Chroma is not installed, migration is deferred and a warning is logged. Do not remove the legacy directory until migration is verified or its data is intentionally retired.

The memory list and clear operations include semantic and episodic records. User-filtered deletion removes semantic records belonging to that user and episodes listing that user as a participant.
