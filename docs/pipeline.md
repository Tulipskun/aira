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
10. Characters answer each other the way they answer a person: the next reply is generated as soon as the previous one is posted, with no pause inserted by the code. The only thing that can slow or stop the exchange is the TPM ledger, and the per-turn context budget (one sixth of the window) keeps each reply small enough that several fit in a minute.
11. The user always comes first. A new user message cancels the running exchange, deletes its saved continuation and is answered on its own; a reply that was still being generated for the old exchange is dropped instead of posted. A quiet room can also restart itself: after an uneven gap of 3-14 minutes (three times longer between 02:00 and 09:00) the decision model is asked whether any character actually has something to say, and one voice opens the conversation for the chain to continue.

12. Semantic memory and per-character episodes are persisted in the background. The approved v0.4.0 first-start reset removes all pre-release memories instead of migrating them.

The final speaker in the batch is the owner of turn-level relationship changes. Facts are accepted only for their declared owner. A replacement of an existing fact requires explicit owner confirmation. Duplicate event keys do not award XP, increment flirt counts or mutate profile data a second time.
