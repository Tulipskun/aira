# Memory

## Roles

Embedding 2 is used for both memory retrieval and long-term memory ingestion.

Chroma is the long-term vector memory store.

SQLite is not the long-term semantic memory store; it stores conversation history and structured relationship/state data.

## Retrieval

```text
current user input
  -> Embedding 2
  -> Chroma similarity search
  -> relevant memories
  -> temporary search_memory(username) result
  -> Gemini 1
```

The memory search is performed before Gemini 1 so the dialogue model receives relevant memories as request-local context.

## Ingestion

Gemini 2 may return `ingest_memory(...)` as part of its forced `execute` operations.

```text
Gemini 2
  -> ingest_memory
  -> Embedding 2
  -> Chroma
```

Memory ingestion that is not required to construct the current Discord response may run after the response has been sent.

## Request isolation

Fake memory tool calls/results are temporary request data. They are not written into conversation history.

Memory records may contain application metadata such as user association and timestamp, but Discord user IDs are application-side data and are not sent to Gemini.
