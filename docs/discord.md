# Discord

## Message handling

- Messages from bots are ignored.
- Any message beginning with `!` is treated as a command and never enters the AI pipeline.
- Unknown `!` commands are ignored.
- Registered commands currently: `!islacomehere`, `!unset`.

## Owner-only commands

`DISCORD_OWNER_ID` identifies the only Discord user allowed to execute the registered commands.

- `!islacomehere` — locks the AI response channel to the channel where the command was sent.
- `!unset` — removes the channel lock.
- Non-owner attempts are ignored.

## Channel lock

Normal AI messages are accepted only when `message.channelId` matches the persisted response channel ID.

The channel lock is stored in `data/discord-config.json`, so it survives process restart. `data/` is gitignored and must remain local runtime state.

If no channel is configured, normal messages are ignored until the owner runs `!islacomehere`.

Discord user IDs are used internally for identity but are not sent to Gemini.
