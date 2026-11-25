# Discord

## Message handling

- Bot messages are ignored.
- Messages beginning with `!` are command messages and never enter the AI pipeline.
- Unknown `!` commands are ignored.
- Registered commands are `!islacomehere` and `!unset`.
- The `!islacomehere` and `!unset` prefix commands are restricted to the Discord application owner resolved at runtime. Slash commands are not subject to Aira’s owner check; actual availability follows the Discord application command permissions.

## Channel lock

The AI responds only in the configured channel.

`!islacomehere` sets the current channel as the AI channel.

`!unset` clears the channel lock.

The configuration is persisted in `.aira/discord-config.json` and therefore survives process restart. `.aira/` is runtime state and is gitignored. The channel lock is also configurable from the owner-only Control Panel.

If no channel is configured, normal messages are ignored. On first startup the Control Panel is posted in the first writable text channel the bot finds; that does not automatically make the panel channel the response channel. The application owner must select a response channel from the panel.

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

## Sessions

Every message belongs to one conversation stream — its **session** — and history plus long-term
memory are read and written inside that stream only.

- `user:<id>` — the default. One private stream per Discord user: nobody else's messages or recalled
  facts ever enter their context.
- `group:<channel>` — opt-in with `/isla join-group`. Everyone who joined *that channel* shares one
  stream: their messages merge into a single turn, she answers once, and memories written there are
  retrievable by the whole room.

Slash commands:

| command | effect |
|---|---|
| `/isla join-group` | share this channel's stream with everyone else who joined it |
| `/isla leave-group` | back to a private stream (idempotent) |
| `/isla status` | which stream the *next* message lands in, and who else is in it |
| `/isla leaderboard` | public top-10 XP leaderboard |

Membership is stored in SQLite (`group_sessions`) and survives restarts. Joining is per channel: a
user who joined in channel A and writes in channel B is routed to their private stream, because they
are not in A's room. The command payload lives in `src/bot/interactions.ts` (`islaCommandPayload()`) and is applied with `bun run scripts/register-commands.ts`. Join, leave and status replies are ephemeral; the leaderboard is intentionally public.

## Identity and attachments

Discord `userId` is the stable internal identity and is used for SQL history/profile data and for
session routing. It is not sent to Gemini in a private session; in a shared session the model *is*
shown each speaker's id, because it has to answer the right person.

The application keeps only the attachment filename in conversation data. Bundled emotion images are
resolved locally from `images/`; no legacy-repository fetch is used at runtime.

`images/` is the registry: its listing is the `select_image` enum Gemini 2 is offered, and the same
listing is what a returned filename is validated against — both read at request time, so adding a
picture needs no code change and no restart. Optional `images/manifest.json` adds a Thai `description`
per file (that text is what the model reads when choosing); a file missing from the manifest is still
offered, just without a description. Override the folder with `ISLA_IMAGES_DIR`.

## Scheduling

Accepted messages are passed to `MessageScheduler`. Scheduling is per **session**: messages in the
same stream merge into one turn (5-second debounce, 12-second maximum wait), and a message from a
different session interrupts the pending batch so the other conversation can be answered immediately.
See `docs/scheduler.md`.

## Owner-only Control Panel

When the Discord gateway becomes ready, Aira publishes or refreshes an `Aira • Control Panel` embed in the first guild text channel where it can view and send messages. Only the Discord application owner can use its controls. The panel supports:

- Select the channel where Aira should process and answer normal messages.
- Set one or more comma-separated Gemini API keys.
- Set the Gemini 1 dialogue, Gemini 2 analyzer and embedding model names.
- Create or edit a character definition, aliases, prompt and enabled state. Isla cannot be disabled. Character changes are loaded for subsequent turns; no restart is required.
- Refresh the displayed settings.

Gemini keys and model settings are stored in `.aira/settings.json` with mode `0600`. The bot token is stored separately in `.env` with mode `0600`. Keep `.aira/` and `.env` private and out of Git.

The Control Panel is not a Discord slash command. It is a persistent message with interactive components. If the bot cannot find a writable text channel, it logs a warning and does not publish the panel.
