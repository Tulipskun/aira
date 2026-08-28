# Long-term Memory

ChromaDB stores long-term memories. It is not the source of truth for conversation history or relationship state.

Flow:

`text -> Gemini Embedding 2 -> vector -> ChromaDB`

Search:

`query -> Gemini Embedding 2 -> vector -> ChromaDB -> memories`

The embedding model is `gemini-embedding-2` by default and can be overridden with `GEMINI_EMBEDDING2_MODEL`. Output dimension defaults to 768 and can be changed with `GEMINI_EMBEDDING2_DIMENSION`.

Chroma receives precomputed embeddings from Gemini, so it does not silently use a different embedding model.

Environment:

- `CHROMA_HOST` (default `localhost`)
- `CHROMA_PORT` (default `8000`)
- `CHROMA_SSL` (default `false`)
- `CHROMA_COLLECTION` (default `aira_memories`)
- `GEMINI_EMBEDDING2_API_KEY` or `GEMINI_EMBEDDING2_API_KEYS`
- `GEMINI_EMBEDDING2_MODEL`
- `GEMINI_EMBEDDING2_DIMENSION`

Embedding API keys rotate on 429 and the current index is persisted in `.gemini-key-state.json`.
