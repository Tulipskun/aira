# Memory

## Components

Gemini Embedding 2 is the embedding model used for both memory retrieval and long-term memory ingestion.

Chroma is the long-term vector memory database. Chroma stores vectors and metadata; Gemini Embedding 2 creates the vectors.

SQLite is not the semantic memory store. It stores conversation history and structured relationship/profile data.

## Retrieval

```text
current user input
  -> Gemini Embedding 2
  -> Chroma similarity search
  -> relevant memories
  -> temporary search_memory(username) result
  -> Gemini 1
```

The memory search is performed before Gemini 1 so the dialogue model receives relevant memories as request-local context.

## Ingestion

Gemini 2 may return `ingest_memory(...)` as part of its forced execute operations.

```text
Gemini 2
  -> ingest_memory
  -> Gemini Embedding 2
  -> Chroma
```

Memory ingestion that is not required to construct the current Discord response may run after the response has been sent.

## Runtime storage

The Node application's local runtime state is stored under `.aira/` and ignored by Git. Chroma itself is accessed through `CHROMA_URL` and is not the SQLite database.

## Request isolation

Fake memory tool calls/results are temporary request data. They are not written into conversation history.

Memory records may contain application metadata such as user association and timestamp, but Discord user IDs are application-side data and are not sent to Gemini.
