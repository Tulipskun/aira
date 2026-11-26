# Turn pipeline

1. Discord receives a message in the configured response channel.
2. The per-session scheduler batches nearby messages (5-second debounce, 12-second maximum wait).
3. Attachments are fetched from Discord CDN hosts and prepared for the model.
4. Every incoming message is saved to shared room history in SQLite as its own row, with its Discord message id and the id of the message it replies to, so the transcript keeps who said what and who answers whom.
5. The speaker decision model (`decisionModel`, default `gemini-decision-1`) receives the room rules and the transcript as one shared input and answers one yes/no decision question per character. The `noul` probability it returns is how likely that character should answer; anything at or above the threshold speaks, in that order, with no cap on how many answer. The model reads whether a message is addressed to a character or only mentions them.
6. Each selected character gets the shared room history plus only its own semantic/episodic memories, user relationship and directed relationships with other characters.
7. If Isla is selected, Gemini 1 generates her dialogue and summary; Gemini 2 analyzes user relationship state, facts and memory. State changes are applied idempotently.
8. If another character is selected, Gemini 1 generates that character's dialogue, summary and private memory updates. The character may also update its own view of another character.
9. Character replies are posted as soon as each one is generated, and every card carries the Discord id of the message it answers. After the batch, the decision model is asked whether the last line points at another character; when it does, the continuation worker lets that character answer the card, so an exchange can run back and forth. Empty replies are not sent.
10. How far an exchange runs is not a fixed count. The TPM ledger measures the average input tokens per request in the current window and allows `capacity ÷ averageRequestTokens` requests per minute; the chain ends when the remaining window budget cannot pay for another turn.
11. Semantic memory and per-character episodes are persisted in the background. The approved v0.4.0 first-start reset removes all pre-release memories instead of migrating them.

The final speaker in the batch is the owner of turn-level relationship changes. Facts are accepted only for their declared owner. A replacement of an existing fact requires explicit owner confirmation. Duplicate event keys do not award XP, increment flirt counts or mutate profile data a second time.
