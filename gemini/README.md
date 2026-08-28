# Gemini Context

Gemini receives conversation context from SQL through `ctxWindowCreate`.

The persistent SQL identity fields are intentionally separated from AI context:

- Discord `user_id` stays internal and is never sent to Gemini.
- `user_name` is sent as the visible author name.
- `file_name` is sent only as filename metadata.
- Actual file contents/URIs are not stored in SQL.

Gemini1 is the normal text-response model. Gemini2 is the forced-tool-call model. Their API keys and model settings are separate.

Temporary fake tool calls/results are request-only context and are never written to SQL history.
