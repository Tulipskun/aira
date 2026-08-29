# Discord

## Message handling

- Bot messages are ignored.
- Messages beginning with `!` are command messages and never enter the AI pipeline.
- Unknown `!` commands are ignored.
- Registered commands are `!islacomehere` and `!unset`.
- Registered commands are owner-only via `DISCORD_OWNER_ID`.

## Channel lock

The AI responds only in the configured channel.

`!islacomehere` sets the current channel as the AI channel.

`!unset` clears the channel lock.

The configuration is persisted in `data/discord-config.json` and therefore survives process restart. `data/` is runtime state and is gitignored.

If no channel is configured, normal messages are ignored.

## Identity and attachments

Discord `userId` is the stable internal identity and is used for SQL history/relationship data. It is not sent to Gemini.

The application keeps only the attachment filename in conversation data. Bundled emotion images are resolved locally from `images/`; no legacy-repository fetch is used at runtime.

## Scheduling

Accepted messages are passed to `MessageScheduler`. Scheduling is per user: a user's new message resets the 5-second debounce, with a 12-second maximum wait. A message from another user interrupts the pending batch so the previous user's response can be processed immediately.
