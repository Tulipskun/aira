# Gemini integration

Gemini 1 generates character dialogue and summaries. Gemini 2 analyzes relationship state, facts, nicknames and memory candidates. The configured Gemini embedding model creates query and document vectors.

The integration uses the Google Gen AI Python SDK Interactions API. Requests are asynchronous and use structured JSON output. API keys are configured only through the owner-only Discord /aira panel and stored in .aira/settings.json; no environment variables or .env file are read. Keys are pooled and rotated after rate-limit responses.

Gemini 1's prompt is prompts/isla.md; Gemini 2's state prompt is prompts/isla-state.md. The state prompt is re-read per turn. Numeric thresholds and relationship permissions remain enforced in Python/SQLite.

Payload diagnostics are disabled by default. Request and response payloads may contain conversation history, attached media, system prompts and personal information.
