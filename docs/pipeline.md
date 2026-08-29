# AI Pipeline

`pipeline.ts` processes a scheduled batch from Discord.

## Request path

1. Read conversation history from SQLite.
2. Add the new user messages to the context.
3. Persist the incoming user messages to SQLite history.
4. Embed the current input with Embedding 2.
5. Search Chroma for relevant long-term memories.
6. Load relationship/state for the users involved from SQLite.
7. Put relationship/state data into Gemini instructions.
8. Put relevant Chroma results into the temporary fake `search_memory(username)` call/result for Gemini 1.
9. Send the context to Gemini 1 and wait for its text response.
10. Send the completed Gemini 1 context/response to Gemini 2 and wait for Gemini 2.
11. Gemini 2 returns the forced `execute` operations.
12. Parse and apply relationship/stat operations to SQLite.
13. Resolve `select_image(filename)` against the bundled local `images/` registry.
14. Read the final relationship/state needed by the response.
15. Return the final text, relationship data and selected image to the Discord handler.
16. Send the Discord response.

## After response

Long-term memory ingestion that is not needed for the current response may continue in background:

```text
Gemini 2 ingest_memory
  -> Embedding 2
  -> Chroma
```

The application must not send the Discord reply before Gemini 2 has completed when its output is required for relationship/state or emotion-image selection.

## Multi-user turns

A scheduled batch may contain messages from multiple users. Each message retains its internal Discord `userId`, username, timestamp and optional filename. The ID is used by the application for SQL operations but is not included in Gemini input.

## Temporary memory tool

`search_memory(username)` is a fake/request-local tool representation. Its result is built from Chroma search results before Gemini 1 is called. It is not persisted as conversation history.
