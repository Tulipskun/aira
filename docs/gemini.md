# Gemini integration

Gemini 1 (`gemini-3.8-live-extended-thinking`, thinking level MEDIUM) generates character dialogue and summaries. The cast runs at MEDIUM because HIGH finishes thinking after the turn closes and only a preamble is spoken; HIGH also stops the reply being valid JSON. Gemini-chan, the room's assistant, runs on `gemini-3.8-live` on its own allowance (`assistant_token_budget`, `AIRA_ASSISTANT_TPM_LIMIT`) because only that model emits Live function calls, which she uses to read the room, the code and the docs. Gemini 2 analyzes relationship state, facts, nicknames and memory candidates. The configured Gemini embedding model creates query and document vectors.

The integration uses the Google Gen AI Python SDK Interactions API. Requests are asynchronous and use structured JSON output. API keys are configured only through the owner-only Discord /aira panel and stored in .aira/settings.json; no environment variables or .env file are read. Keys are pooled and rotated after rate-limit responses.

Gemini 1's prompt is prompts/isla.md; Gemini 2's state prompt is prompts/isla-state.md. The state prompt is re-read per turn. Numeric thresholds and relationship permissions remain enforced in Python/SQLite.

Payload diagnostics are disabled by default. Request and response payloads may contain conversation history, attached media, system prompts and personal information.
