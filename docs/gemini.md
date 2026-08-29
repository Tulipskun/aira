# Gemini

Gemini 1 and Gemini 2 are separate model roles and use separate API-key pools.

## Gemini 1

Gemini 1 is the dialogue model.

Its `systemInstruction` is assembled at runtime:

```text
src/gemini/prompts/isla.md
      +
<user_profile>...</user_profile>
```

The character prompt is stored in `GEMINI1_SYSTEM_PROMPT_FILE` and can be changed without modifying application code.

The `<user_profile>` block contains only:

- name
- relationship label in human-readable form, such as `คนรัก`
- nicknames assigned by Isla
- facts

Internal `userId`, XP and affinity are not sent to Gemini 1.

Relevant Chroma memories are provided separately through the temporary fake `search_memory(username)` call/result.

## Gemini 2

Gemini 2 runs only after Gemini 1 has completed. Its input includes the relevant turn/context and Gemini 1's response.

Gemini 2 uses one forced `execute` function. The function arguments contain operations the application must perform, for example:

- relationship/stat updates
- `ingest_memory(...)`
- `select_image(...)`
- future user-profile updates

The application parses the returned operations and applies them to SQL, Chroma, and the local image registry.

Gemini 2 is on the synchronous response path because its relationship/state result and selected image can be required before the Discord reply is sent.

Fake tool call/result data is request-local and is not stored as conversation history.
