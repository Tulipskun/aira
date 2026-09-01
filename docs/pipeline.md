# AI Pipeline

`src/pipeline/pipeline.ts` processes a scheduled batch from Discord.

## Request path

1. Read conversation history from SQLite — the last turns of **this message's session only**
   (`getHistory(50, sessionKey)`), not one global stream shared by every user.
2. Add the new user messages to the context.
3. Persist incoming user messages to SQLite history, stamped with the session key.
4. Embed the current input with Embedding 2.
5. Search Chroma for relevant long-term memories, filtered to the same session key.
6. Load the profile of **everyone who spoke in this turn** from SQLite (one row per user; a private
   session has exactly one).
7. Build Gemini 1 `systemInstruction` from the configurable system prompt file, followed by the
   identity block for the turn: a single `<user_profile>` when the session is private, or a
   `<group_session>` containing one `<user_profile>` per speaker — with the person she is answering
   named as such — when the session is shared.
8. Put relevant Chroma results into the temporary fake `search_memory(username)` call/result for Gemini 1.
9. Send the context to Gemini 1 and wait for its text response.
10. Send the completed Gemini 1 context/response to Gemini 2 and wait for Gemini 2.
11. Gemini 2 returns one flat JSON object (`affinity`, the approval flags, `select_image`,
    `add_facts`, `add_nicknames`, `ingest_memory`) — never a relationship rung.
12. Parse that object and apply it to SQLite/Chroma; the bond itself is derived in code
    (`deriveBond()`), so the ladder cannot be bypassed by a model.
13. Resolve `select_image(filename)` against the `images/` directory listing (the registry is the
    directory itself, read at request time), and read back the post-turn profile — bond, xp, this
    turn's delta, nicknames — as the card the embed footer is built from.
14. Return the final text and selected image to the Discord handler.
15. Send the Discord response.

## Gemini 1 user profile

The character/system prompt is loaded from `GEMINI1_SYSTEM_PROMPT_FILE` (default `./src/gemini/prompts/isla.md`) and is not hardcoded in `pipeline.ts`.

The dynamic profile is appended after that prompt:

```xml
<user_profile>
ชื่อ: Yuuta
ความสัมพันธ์กับ Isla: คนรัก (lover, ระดับ 4)
ความใกล้ชิดสะสม (xp): 640
ฉายาที่ Isla ตั้งให้: คนโปรด, คนขี้แกล้ง
fact:
- ชอบให้ไอล่าเรียกว่าที่รัก
- ชอบหมา
- เคยบอกว่าเป็นประธานบริษัท
</user_profile>
```

Only profile information is placed in this block: name, relationship label, accumulated xp,
Isla-assigned nicknames and facts. Internal Discord user IDs and the separate `affinity` figure are
not included in a private session.

xp is the one number in here, and deliberately so: it is the ladder's fuel, so Gemini 1 needs it to
know how far she is from the next rung. It is shown as a count, never as a permission — the rung
itself is still computed in code and Gemini 1 cannot change it.

### Shared sessions

In a `group:<channel>` session the block becomes a `<group_session>` wrapper holding one
`<user_profile>` per speaker, each labelled with that person's Discord id — the id is the only thing
that ties `@Name` in the message to the right profile when several people share one stream. The
wrapper states that the room shares one history, that lines are prefixed by their speaker, that
facts/nicknames/rungs do not cross between blocks, and which of them Isla is answering this turn
(the last speaker of the batch, whose ladder moves).

A private turn renders `profileBlock()` byte-for-byte as before: that block is the stable part of
Gemini 1's cached prefix, so a group-only change must not leak into it.

Gemini 2 receives the turn as a transcript (`turnTranscript()`) rather than one name prefixed over
the whole batch, plus a line naming whose `<current_state>` follows, because every field it reports
belongs to exactly one user. See `<whose_turn>` in `src/gemini/prompts/isla-state.md`.

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
