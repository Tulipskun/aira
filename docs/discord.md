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

The configuration is persisted in `.aira/discord-config.json` and therefore survives process restart. `.aira/` is runtime state and is gitignored.

If no channel is configured, normal messages are ignored.

## AI response

AI replies are sent as a Discord Embed rather than plain message content.

- Embed description: Gemini 1 response text
- Embed image: local emotion image selected by Gemini 2, when available
- Embed footer, two lines:
  1. the relationship card — display name (max 12 characters), the bond's Thai label and its mark,
     the accumulated xp with this turn's change in brackets, and up to three nicknames as `#tags`,
     e.g. `Farris (คนรัก) ❤️ 199 [+12] #คนโปรด #คนขี้แกล้ง`
  2. Isla's own mood, e.g. `อารมณ์: สงบ`
  When neither line can be built the footer falls back to `Isla`.
- Embed timestamp: the moment the reply was assembled (`Date.now()`), never a hardcoded value. It is
  deliberately *not* the incoming message's timestamp: the pipeline runs for tens of seconds, and
  Discord renders this as the reply's own time.
- The selected image is attached to the same Discord message and referenced with `attachment://...`

## Identity and attachments

Discord `userId` is the stable internal identity and is used for SQL history/relationship data. It is not sent to Gemini.

The application keeps only the attachment filename in conversation data. Bundled emotion images are resolved locally from `images/`; no legacy-repository fetch is used at runtime.

`images/` is the registry: its listing is the `select_image` enum Gemini 2 is offered, and the same
listing is what a returned filename is validated against — both read at request time, so adding a
picture needs no code change and no restart. Optional `images/manifest.json` adds a Thai `description`
per file (that text is what the model reads when choosing); a file missing from the manifest is still
offered, just without a description. Override the folder with `ISLA_IMAGES_DIR`.

## Scheduling

Accepted messages are passed to `MessageScheduler`. Scheduling is per user: a user's new message resets the 5-second debounce, with a 12-second maximum wait. A message from another user interrupts the pending batch so the previous user's response can be processed immediately.
