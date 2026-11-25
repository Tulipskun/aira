# Installation and deployment

## Pterodactyl Python 3.13

1. Create a server using a Python 3.13 egg/image.
2. Configure the Git repository as `https://github.com/Tulipskun/aira`, branch `main`, with user upload disabled. Enable automatic repository updates only if the panel's Git deployment workflow is configured to preserve the writable server data directory.
3. Use this startup command exactly:

   ```bash
   python -m pip install -r requirements.txt && python main.py
   ```

4. Add the `DISCORD` environment variable with the bot token. Set `DISCORD_OWNER_ID` if desired. The bot can start without a Gemini key so that its owner can add one through the Control Panel.
5. Start the server. Aira warms DNS/HTTPS connections, logs in and posts its owner-only Control Panel to a text channel it can access. Use the panel to choose the response channel and configure Gemini API keys/model names.
6. Enable Message Content Intent in the Discord Developer Portal. Invite the bot with `bot` and `applications.commands` scopes and grant View Channels, Send Messages, Read Message History, Embed Links and Attach Files.

Pterodactyl manages the foreground process. Do not wrap `main.py` in a daemon or shell installer. SIGTERM/SIGINT are handled for graceful shutdown.

## Slash-command registration

Aira does not run a global Discord application-command sync on every startup, because a full sync could overwrite unrelated commands registered by other app features. Existing `/isla` commands continue to work. To update this command group, first run `python -m aira.register_commands --dry-run`, review the preserved-command count and payload, and then run `python -m aira.register_commands` once. This replaces only the `/isla` group and preserves every other global command.

## Environment variables

See [`.env.example`](../.env.example). Only `DISCORD` is required at process startup. The owner-only Control Panel can store Gemini keys and models in `.aira/settings.json`; this file is private runtime state and is not committed.

## Persistent storage and upgrades

The following paths must survive restarts and code updates:

- `.aira/aira.db` — SQLite history and structured user state.
- `.aira/chroma/` — semantic and episodic memory.
- `.aira/settings.json` — API keys/models saved from Discord.
- `.aira/discord-config.json` — selected response channel.

Do not delete or replace `.aira/` during an update. A fresh Pterodactyl server does not automatically inherit data from an older server; transfer the existing data directory using the panel's supported file migration before switching traffic.

Embedded Chroma is used by default. The Python requirements include a bundled FFmpeg binary for animated GIF conversion, so the egg does not need to install FFmpeg through apt. A separate Chroma server is optional; set `CHROMA_URL` to its endpoint when using one. The repository's optional `docker-compose.yml` starts Chroma on loopback port 8000.

## Local development

```bash
python -m venv .venv
. .venv/bin/activate
python -m pip install -r requirements.txt
cp .env.example .env
# Set DISCORD in .env
python main.py
```

## Troubleshooting

- **Missing DISCORD:** set the bot token in Pterodactyl environment variables. Do not put it in the Git repository.
- **Bot connects but ignores messages:** select the response channel in the Control Panel and enable Message Content Intent.
- **Gemini API key missing:** configure one through the Discord Control Panel or set `GEMINI_API_KEY`.
- **Memory is empty after migration:** confirm that the previous `.aira/chroma/` data was transferred; Chroma is not included in the Git repository.
- **Data disappears after redeploy:** configure persistent Pterodactyl storage for `.aira/` and avoid deleting it in Git deployment hooks.
- **Python dependency installation fails:** confirm that the server uses Python 3.13 and that the egg permits outbound package downloads.
