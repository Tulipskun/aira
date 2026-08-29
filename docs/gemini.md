# Gemini

Gemini 1 and Gemini 2 are separate model roles and use separate API-key pools.

## API keys

Each pool supports multiple keys.

- Start with the persisted current key.
- On `429`, rotate to the next key.
- Stay on the new key until another `429` occurs.
- On retryable `5xx`, retry the same key with backoff.
- Key state is persisted to disk so a restart does not reset rotation state.

## Gemini 1

Gemini 1 is the dialogue model.

Input includes the application-built conversation context, relationship information in instructions, and a temporary fake memory tool call/result containing relevant Chroma memories.

Gemini 1 returns ordinary text. The application does not treat its response as a real persisted tool call.

## Gemini 2

Gemini 2 runs only after Gemini 1 has completed. Its input includes the relevant turn/context and Gemini 1's response.

Gemini 2 uses one forced `execute` function. The function arguments contain the operations the application must perform, for example:

- `set_self_status(...)`
- `adjust_<username>_affinity(...)`
- `ingest_memory(...)`
- `select_image(...)`

The application parses the returned operations and applies them to SQL, Chroma, and the local image registry.

Gemini 2 is on the synchronous response path because its relationship/state result and selected image can be required before the Discord reply is sent.

Fake tool call/result data is request-local and is not stored as conversation history.
