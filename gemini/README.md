# Gemini Context

Gemini receives conversation context from SQL through `ctxWindowCreate`.

The persistent SQL identity fields are intentionally separated from AI context:

- Discord `user_id` stays internal and is never sent to Gemini.
- `user_name` is sent as the visible author name.
- `file_name` is sent only as filename metadata.
- Actual file contents/URIs are not stored in SQL history.

Gemini1 is the normal text-response model. Relationship state is supplied through `system_instruction`.

Chroma long-term memory is supplied to Gemini1 as temporary `search_memory(username)` function-call/result steps. These steps are never persisted to SQL.

Gemini2 receives the completed Gemini1 context and is forced to call one `execute` function. The application parses the returned commands and performs memory ingestion and relationship/stat updates in the background.

The implementation uses the current Gemini Interactions API field names (`system_instruction` and `generation_config`) and keeps `store: false`. Streaming is not used.
