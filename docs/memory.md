# Memory

## Components

Gemini Embedding 2 creates vectors for semantic and episodic memory. Chroma is the long-term vector store.
SQLite stores conversation history and structured relationship/profile state.

## Runtime

The Bun supervisor starts local Chroma at `.aira/chroma/` and the application connects to
`CHROMA_URL` (default `http://127.0.0.1:8000`). `.aira/` is ignored by Git.

## Retrieval

```text
current input
  -> Gemini Embedding 2
  -> Chroma semantic search + episodic search
  -> session-scoped results
  -> temporary search_memory(username) result
  -> Gemini 1
```

Every pipeline memory query is scoped to one `sessionKey`. `userId` identifies who the memory is about;
`sessionKey` identifies which conversation stream can retrieve it. This distinction is especially
important for group sessions.

## Ingestion

Gemini 2 may return `ingest_memory`. The response path does not wait for it:

```text
Gemini 2
  -> return response/state
  -> Discord reply
  -> background Embedding 2
  -> duplicate check
  -> Chroma
```

Background ingestion is best-effort. Embedding/Chroma failure is logged and does not invalidate a
successful Discord response.

## Timestamps

Semantic memories store:

- `eventTimestamp`: timestamp of the source event represented by the memory.
- `createdAt`: timestamp when the memory record was persisted.

Facts use their source event timestamp. Episodes additionally store `createdAt` and the participant
IDs that contributed to the episode, which prevents group-session episodes from losing identity context.

## Request isolation

The fake `search_memory(username)` representation exists only inside the current Gemini 1 request. It
is never stored as conversation history.
