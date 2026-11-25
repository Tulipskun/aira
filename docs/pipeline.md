# Turn pipeline

1. Discord receives a message in the configured response channel.
2. The per-session scheduler batches nearby messages (5-second debounce, 12-second maximum wait).
3. Attachments are fetched from Discord CDN hosts and prepared for the model.
4. The combined user turn is saved to SQLite before external model/vector calls.
5. Gemini Embedding creates a query vector. Chroma returns semantic and episodic memories scoped to the current session.
6. SQLite profiles for the speakers are loaded. Channel context is shared by everyone in the same Discord channel; identity, facts and relationship state remain separate per user.
7. Gemini 1 produces Isla's response and a one-turn summary. The response and summary are stored in SQLite.
8. Gemini 2 analyzes the user turn, Isla response and current profiles. The parser validates state signals and enforces allowed types/ranges.
9. SQLite applies XP, relationship progression, approvals, facts and nicknames in one idempotent transaction keyed by `(session_key, user_id, event_timestamp)`.
10. Isla's response is sent with the selected local expression image, color, mood and optional RPS interaction.
11. Up to two additional characters may answer in separate embeds. Semantic memory and episode ingestion run in the background.

The final speaker in the batch is the owner of turn-level relationship changes. Facts are accepted only for their declared owner. A replacement of an existing fact requires explicit owner confirmation. Duplicate event keys do not award XP, increment flirt counts or mutate profile data a second time.
