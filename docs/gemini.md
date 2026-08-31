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

Gemini 2 answers with one flat JSON object, forced by the request's `response_format` (the same
mechanism Gemini 1 uses). It reports *facts about the turn* — never a relationship rung:

- `affinity` — how much the relationship moved (this becomes xp)
- `is_flirt`, `approve_lover`, `approve_soulmate`, `approve_sibling`, `approve_family`
- `select_image` — a filename from the `images/` directory, or `none`
- `add_facts`, `add_nicknames`, `ingest_memory`

The application parses that object and applies it to SQL, Chroma, and the local image registry; the
bond itself is computed in code (`deriveBond()` in `src/sql/bonds.ts`), so a model can never name a
rung or skip a prerequisite.

Gemini 2 is on the synchronous response path because its relationship/state result and selected image can be required before the Discord reply is sent.

Fake tool call/result data is request-local and is not stored as conversation history.
