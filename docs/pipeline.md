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
10. The cast speaks on a fixed ten second beat, so the automated pass is predictable. What adapts is the context budget: one turn may spend at most `capacity ÷ 6` tokens, which is exactly the sixth of a minute that the beat needs, and history is trimmed to fit it. The chain continues while the remaining window can still pay for another turn.
11. A quiet room can also restart itself the way a group of friends does: the idle loop waits an uneven gap of 3-14 minutes (three times longer between 02:00 and 09:00), then rolls the odds against starting at all, and finally asks the decision model whether any character actually has something to say. One voice starts and the normal continuation chain takes over. It never starts twice more than four times an hour, never in a room that has been dead for half a day, and never when the TPM window cannot pay for the turn.
12. Semantic memory and per-character episodes are persisted in the background. The approved v0.4.0 first-start reset removes all pre-release memories instead of migrating them.

The final speaker in the batch is the owner of turn-level relationship changes. Facts are accepted only for their declared owner. A replacement of an existing fact requires explicit owner confirmation. Duplicate event keys do not award XP, increment flirt counts or mutate profile data a second time.
