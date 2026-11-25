# Aira

Discord AI character bot powered by Gemini, SQLite and Chroma. Runtime: Python 3.13. Isla is the default character; additional characters can join the same bot and Discord response channel.

## Features

- One Discord bot with Isla and multiple configurable characters. Isla always replies first; Gemini can invite at most one additional character, and direct character mentions take priority.
- Gemini 1 generates dialogue and summaries. Gemini 2 analyzes relationship changes, facts, nicknames, memory and Isla's expression image.
- Per-user relationship state, XP, accepted flirt count, gated proposals, facts and nicknames. Each Discord channel has one shared conversation context; users in the same channel share history and memory while personal profiles remain separate.
- SQLite conversation history and atomic, idempotent relationship-state updates.
- Chroma semantic and episodic memory, separated by conversation session and character.
- Owner-only Discord Control Panel for Gemini keys/models, response channel and character prompts.
- Attachment understanding for images, audio, video, PDF and text; images are resized before being sent to Gemini.
- Debounced message batching, typing indicator, RPS interactions, slash commands and a loopback health endpoint.
- Admin CLI for reviewing and selectively deleting history and memories. Destructive commands are dry-run unless `--yes` is supplied.

## Pterodactyl deployment

Use a **Python 3.13** egg/image and deploy the public Git repository:

| Setting | Value |
| --- | --- |
| Git repository | `https://github.com/Tulipskun/aira` |
| Branch | `main` |
| User upload | `0` |
| Auto update | `1` |
| Startup command | `python -m pip install -r requirements.txt && python main.py` |

Set these environment variables in the panel:

| Variable | Required | Purpose |
| --- | --- | --- |
| `DISCORD` | No (legacy) | Optional migration source. Without it, enter the bot token in the server Console on first start; Aira saves it in `.aira/discord.token`. |
| `DISCORD_OWNER_ID` | Recommended | Discord owner user ID. The bot also checks the application owner returned by Discord. |
| `GEMINI_API_KEY` | No | Optional shared comma-separated Gemini API key pool. Can also be configured after startup through the owner-only Discord Control Panel. |
| `GEMINI1_API_KEYS`, `GEMINI2_API_KEYS`, `GEMINI_EMBEDDING2_API_KEYS` | No | Optional stage-specific key pools; fall back to `GEMINI_API_KEY`. |
| `DISCORD_RESPONSE_CHANNEL_ID` | No | Optional initial response channel. The panel can select/change it later. |
| `GEMINI1_MODEL` | No | Gemini dialogue model; defaults to `gemini-3.1-flash-lite`. |
| `GEMINI2_MODEL` | No | Gemini analysis model; defaults to `gemini-3.5-flash-lite`. |
| `GEMINI_EMBEDDING2_MODEL` | No | Embedding model; defaults to `gemini-embedding-2`. |
| `CHROMA_URL` | No | Optional remote Chroma server. Leave empty to use embedded persistent Chroma in `.aira/chroma`. |
| `SQLITE_PATH` | No | Defaults to `.aira/aira.db`. |
| `ISLA_TIMEZONE` | No | Defaults to `Asia/Bangkok`. |

The startup command installs the pinned Python requirements and runs the bot in the foreground. Logs are written to the panel console and to the private rotating file `.aira/aira.log`. The process handles SIGTERM and SIGINT and drains queued turns before exiting.

**Discord setup:** invite the application with the `bot` and `applications.commands` OAuth scopes. Grant View Channels, Send Messages, Read Message History, Embed Links and Attach Files in the response channel. Enable the privileged **Message Content Intent** in the Discord Developer Portal.

On first start, paste the Discord bot token into the server Console when prompted. Aira verifies it with Discord and stores it at `.aira/discord.token`; later starts read the saved token automatically. Keep the server Console history private because panel behavior determines whether pasted input is echoed or retained. After login, Aira posts its Control Panel in a server text channel. Only the Discord application owner (or `DISCORD_OWNER_ID`) can change settings. Add a Gemini key in the panel before asking Aira to respond if `GEMINI_API_KEY` was not supplied at deployment.

### Persistent data

Keep the Pterodactyl server's filesystem persistent across restarts and redeployments. Aira writes its SQLite database, Chroma data, model settings, selected channel and API-key state under `.aira/`. This directory is excluded from Git. When moving an existing installation, preserve/copy its existing `.aira/` directory; deploying the source code alone does not transfer private data from another server. Do not replace an existing `.aira/` directory with an empty one during an update.

Aira uses embedded Chroma by default, and the pinned Python FFmpeg package supplies GIF-to-video conversion without requiring an OS-level FFmpeg installation. No Node.js runtime, Bun runtime, shell installer or separate Chroma container is required. To use an external Chroma server, set `CHROMA_URL` to its URL. The optional `docker-compose.yml` starts a local Chroma service; when using it, set `CHROMA_URL=http://127.0.0.1:8000`.

## Local run

Python 3.13 is recommended.

```bash
python -m venv .venv
. .venv/bin/activate
python -m pip install -r requirements.txt
cp .env.example .env
# Start and paste the Discord bot token into the console when prompted:
python main.py
```

The bot runs in the foreground. On first launch, enter the Discord bot token in the console; it is validated and saved under `.aira/` for subsequent launches. The legacy `DISCORD` environment variable is also supported and migrated when present. Gemini credentials can be supplied through `GEMINI_API_KEY` or added through the Discord Control Panel. On startup, Aira performs a bounded DNS/HTTPS warm-up before connecting to Discord.

## Discord commands

- `!islacomehere` — owner-only; select the current channel for responses.
- `!unset` — owner-only; remove the response-channel lock.
- `/isla status` — inspect the current channel's shared conversation session.
- `/isla leaderboard` — show the top users by XP.

The runtime does not automatically replace Discord's global command list on every restart. Existing application commands are preserved. To install/update only Aira's `/isla` command group while retaining unrelated app commands, run `python -m aira.register_commands --dry-run` first, then `python -m aira.register_commands` once after reviewing the payload.

Unknown prefix commands are ignored. Normal messages outside the configured response channel are ignored. Bot-authored messages are never fed back into the pipeline.

## Characters

Each `characters/*.json` file registers a character. Prompts are Markdown files within the repository. Isla remains enabled and is the default character. Character definitions are loaded when a turn is processed, so file-based changes apply without a restart. The Discord Control Panel can also add/edit character profiles and prompts.

Example:

```json
{
  "id": "nova",
  "name": "Nova",
  "aliases": ["โนวา"],
  "promptFile": "prompts/nova.md",
  "enabled": true
}
```

Additional characters use a separate Chroma memory namespace and separate relationship record per user. They share the current Discord conversation history with Isla.

## Data and admin commands

SQLite is authoritative for structured user state and conversation history. Chroma holds semantic and episodic vectors. The bot stores UTC timestamps and renders them in the configured timezone.

Inspect history for a channel (replace CHANNEL_ID with its Discord ID):

```bash
python -m aira.cli history list --session group:CHANNEL_ID
python -m aira.cli memory list --session group:CHANNEL_ID
python -m aira.cli memory search "กาแฟ" --session group:CHANNEL_ID
```

Legacy `user:DISCORD_USER_ID` sessions remain available for inspecting older personal history.

Destructive commands are dry-run by default. Add `--yes` to execute:

```bash
python -m aira.cli history clear --session group:CHANNEL_ID --yes
python -m aira.cli memory clear --user DISCORD_USER_ID --yes
python -m aira.cli history clear --all --yes
python -m aira.cli memory clear --all --yes
```

Use these commands only when the bot is stopped or when you understand that deleted records cannot be recovered. No automatic backup is created by the admin CLI.

## Development and tests

```bash
python -m pip install -r requirements.txt
python -m compileall -q aira tests main.py
python -m unittest discover -s tests -v
```

See `docs/` for the architecture, Discord, Gemini, memory, pipeline, scheduler and SQLite details. See `SECURITY.md` for responsible vulnerability reporting.

Aira is licensed under AGPL-3.0-only. Network users of modified versions must be offered the corresponding source under the same license.
