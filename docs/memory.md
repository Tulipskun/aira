# Memory

## Components

Gemini Embedding 2 is the embedding model used for both memory retrieval and long-term memory ingestion.

Chroma is the long-term vector memory database. Chroma stores vectors and metadata; Gemini Embedding 2 creates the vectors.

SQLite is not the semantic memory store. It stores conversation history and structured relationship/profile data.

## Chroma runtime

Chroma runs as a separate local service started by the Bun supervisor (`scripts/supervisor.ts`). Its persistent storage is:

```text
.aira/chroma/
```

The application connects to `http://127.0.0.1:8000` by default through `CHROMA_URL`. The supervisor starts the local chroma binary with `--path .aira/chroma` and waits for its heartbeat before starting Aira.

`.aira/` is ignored by Git, so Chroma runtime data is never committed to the repository.

## Retrieval

```text
current user input
  -> Gemini Embedding 2
  -> local Chroma server
  -> .aira/chroma
  -> similarity search
  -> relevant memories
  -> temporary search_memory(username) result
  -> Gemini 1
```

The memory search is performed before Gemini 1 so the dialogue model receives relevant memories as request-local context.

## Ingestion

Gemini 2 may return a non-empty `ingest_memory` string as part of its JSON state object.

```text
Gemini 2
  -> ingest_memory
  -> Gemini Embedding 2
  -> local Chroma server
  -> .aira/chroma
```

Memory ingestion that is not required to construct the current Discord response may run after the response has been sent.

## Request isolation

Fake memory tool calls/results are temporary request data. They are not written into conversation history.

Memory records may contain application metadata such as user association and timestamp, but Discord user IDs are application-side data and are not sent to Gemini.
