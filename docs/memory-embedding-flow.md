# Memory and Episode Embedding Flow

Aira uses the same Embedding 2 service for both Chroma retrieval and Chroma ingestion, but with different task types.

```text
Incoming Discord message
        │
        ▼
   Embedding 2
   task=query
        │
        ├───────────────┐
        ▼               ▼
 Chroma Memory      Chroma Episode
   Search              Search
        │               │
        └───────┬───────┘
                ▼
          Gemini 1 / Gemini 2
                │
                ▼
           Discord Reply
                │
                ▼
      Background ingestion
          ┌─────┴─────┐
          ▼           ▼
      Memory        Episode
          │           │
          ▼           ▼
      Embedding 2  Embedding 2
      task=document task=document
          │           │
          ▼           ▼
      Chroma      Chroma
```

## Important distinction

- Query/retrieval embedding: `embed(text, "query")`
- Memory ingestion embedding: `embed(memory.text, "document")`
- Episode ingestion embedding: `embed(episode.text, "document")`

The query vector is used to retrieve semantically similar memories and episodes. New memory and episode records are embedded separately from their stored text before their vectors are written to Chroma.

Memory ingestion also performs a duplicate check using the document embedding before writing the memory vector. Episode ingestion builds the recent episode from SQLite history and then embeds the resulting episode text before writing it to Chroma.

Background ingestion is best-effort: embedding or Chroma failures are logged and do not invalidate an otherwise successful Discord response.
