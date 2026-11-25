# Gemini integration

Gemini 1 generates Isla's user-facing response. Gemini 2 analyzes the completed turn and returns structured relationship signals, facts, nicknames, memory candidates and an emotion-image selection. Embedding uses the configured Gemini embedding model for query and document vectors.

The integration uses the Google Gen AI Python SDK Interactions API. Requests are asynchronous and provide a system instruction, structured JSON response schema and `store=False`. API keys are pooled and rotated on rate-limit responses. Transient server errors receive bounded retries.

API keys can be provided through `GEMINI_API_KEY` (comma-separated), optional stage-specific `GEMINI1_API_KEYS`, `GEMINI2_API_KEYS`, `GEMINI_EMBEDDING2_API_KEYS`, or the owner-only Discord Control Panel. Panel settings are stored in `.aira/settings.json`. Do not put keys in source files or logs.

Gemini 1's prompt is `prompts/isla.md`; Gemini 2's state-analysis prompt is `prompts/isla-state.md`. The state prompt is re-read per turn so wording changes can take effect without restarting the process. Numeric thresholds and relationship permissions remain enforced in Python/SQLite, not delegated to model output.

The parser accepts the original reply field names, validates image filenames against the actual local `images/` files, provides their descriptions to Gemini after removing internal grouping tags, and clamps state changes to the configured affinity range. A malformed JSON response falls back to plain reply text and applies neutral state.


## Optional payload diagnostics

Set `GEMINI_DEBUG_PAYLOAD=1` to enable the bounded payload dump. It stores the latest six request/response/error records under `.aira/logs/gemini-payload.json` (or `GEMINI_DEBUG_PAYLOAD_FILE`). Files use owner-only permissions; API-key/token fields and known credential strings are redacted. Payloads can include user messages, attached media and system prompts, so keep this option disabled unless actively diagnosing a model issue.
