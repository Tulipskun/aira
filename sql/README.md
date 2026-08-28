# SQL

SQLite via Bun `bun:sqlite` is the persistent source of truth for conversation history and relationship state.

## History

`messages` stores:

- `role`: `user` or `model`
- `user_id`: Discord ID; internal only, never sent to Gemini
- `user_name`: display name captured at message time
- `text`
- `timestamp`
- `file_name`: filename only; file contents/URI are not stored here

Fake tool calls/results are temporary Gemini context and are not persisted.

## Relationship

`relationships` stores identity and relationship state by Discord `user_id`, including name, state, XP, and affinity.

`user_id` is the stable identity. `user_name` may change whenever Discord reports a new name.

Gemini2 background commands can update affinity, XP, and relationship state. Those updates are applied using Discord `user_id`, never a username.

## Main flow

`Discord message -> history context -> Gemini1 -> save model response -> Gemini2 background -> relationship updates`
