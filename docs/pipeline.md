# Turn pipeline

1. Discord receives a message in the configured response channel.
2. The per-session scheduler batches nearby messages (5-second debounce, 12-second maximum wait).
3. Attachments are fetched from Discord CDN hosts and prepared for the model.
4. The combined user turn is saved to shared room history in SQLite before any model request.
5. Gemini 2 acts as a social speaker scheduler with no speaker cap: it may choose silence, one character, several, or the whole cast, and it reads whether a message is addressed to a character or only mentions them. A character the message speaks to is always kept, and a room-wide request wakes everyone except whoever is only being talked about.
6. Each selected character gets the shared room history plus only its own semantic/episodic memories, user relationship and directed relationships with other characters.
7. If Isla is selected, Gemini 1 generates her dialogue and summary; Gemini 2 analyzes user relationship state, facts and memory. State changes are applied idempotently.
8. If another character is selected, Gemini 1 generates that character's dialogue, summary and private memory updates. The character may also update its own view of another character.
9. Character replies are sent in order. When both are selected, the later character sees the earlier character's newly saved message and can respond to it. Empty replies are not sent.
10. Semantic memory and per-character episodes are persisted in the background. The approved v0.4.0 first-start reset removes all pre-release memories instead of migrating them.

The final speaker in the batch is the owner of turn-level relationship changes. Facts are accepted only for their declared owner. A replacement of an existing fact requires explicit owner confirmation. Duplicate event keys do not award XP, increment flirt counts or mutate profile data a second time.
