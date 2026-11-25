# Discord integration

Aira uses `discord.py` with guild, guild-message and message-content intents. Enable Message Content Intent in the Discord Developer Portal.

## Routing

Only normal messages in the configured response channel enter the scheduler. Unknown prefix commands are ignored. `!islacomehere` and `!unset` are owner-only and change the configured response channel. Bot-authored messages are discarded to prevent recursive replies.

## Control Panel

The bot publishes a persistent Control Panel in an available guild text channel after login. Only the application owner or `DISCORD_OWNER_ID` may use it. It provides:

- Gemini API-key pool configuration.
- Gemini 1, Gemini 2 and embedding model configuration.
- Response-channel selection.
- Character prompt/alias editing.

Settings are written under `.aira/` with restrictive file permissions. Do not upload that folder to GitHub.

## Slash commands

- `/isla status` shows the current channel's shared conversation session.
- `/isla leaderboard` shows the highest XP profiles.

After a command schema update, the next startup synchronizes the `/isla` command group once, preserving unrelated application commands. The schema version is stored under `.aira/` to avoid syncing on every restart.

Each channel selected as Aira's response channel has its own conversation history and semantic/episodic memory. Everyone speaking in that channel shares its context automatically; users do not need to join or leave a group. When the owner changes the response channel, that channel uses its own isolated history.

## Message processing

Message batches are grouped by session, not by user alone. Attachments are downloaded only from Discord CDN hosts over HTTPS, with redirects disabled and a byte limit. Images are EXIF-corrected and resized to a maximum 1500-pixel edge before Gemini processing. The bot replies with an embed and optional local expression image. RPS responses use an interactive view bound to the initiating Discord user.

## Health endpoint

The bot exposes `GET /health` on `127.0.0.1:8091` by default. It is loopback-only and returns gateway readiness, uptime, selected channel, queue state and message counters. Configure the port with `ISLA_HEALTH_PORT`.
