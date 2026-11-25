# Installation and deployment

## Pterodactyl Python 3.13

1. Create a server using a Python 3.13 egg/image.
2. Configure the Git repository as `https://github.com/Tulipskun/aira`, branch `main`, with user upload disabled. Enable automatic repository updates only if the panel's Git deployment workflow is configured to preserve the writable server data directory.
3. Use this startup command exactly:

   ```bash
   python -m pip install -r requirements.txt && python main.py
   ```

4. Set `DISCORD_OWNER_ID` if desired. Do not add a Discord token variable: on first start, paste the bot token into the server Console when prompted. Aira verifies the token and saves it in `.aira/discord.token`; later starts reuse that saved token. The legacy `DISCORD` variable is still accepted and migrated automatically.
5. Start the server. Aira warms DNS/HTTPS connections, logs in and posts its owner-only Control Panel to a text channel it can access. Use the panel to choose the response channel and configure Gemini API keys/model names.
6. Enable Message Content Intent in the Discord Developer Portal. Invite the bot with `bot` and `applications.commands` scopes and grant View Channels, Send Messages, Read Message History, Embed Links and Attach Files.

Pterodactyl manages the foreground process. Do not wrap `main.py` in a daemon or shell installer. SIGTERM/SIGINT are handled for graceful shutdown.

## Slash-command registration

On the next startup after a schema change, Aira replaces the global Discord slash-command list with exactly one command: `/aira`. Existing global slash commands for this application are removed. The schema version is stored under `.aira/` so synchronization is not repeated on every restart.

## Environment variables

See [`.env.example`](../.env.example). `DISCORD` is no longer required: Aira asks for the token in the Console on first start and persists it in `.aira/discord.token`. Keep Console history private; whether pasted input is echoed or retained depends on the hosting panel. Existing `DISCORD` variables are accepted as a migration path. The owner-only Control Panel can store Gemini keys and models in `.aira/settings.json`; this file is private runtime state and is not committed.

## Persistent storage and upgrades

The following paths must survive restarts and code updates:

- `.aira/aira.db` — SQLite history and structured user state.
- `.aira/chroma/` — semantic and episodic memory.
- `.aira/settings.json` — API keys/models saved from Discord.
- `.aira/discord-config.json` — selected response channel.
- `.aira/discord.token` — verified Discord bot token (owner-only file permissions).

Do not delete or replace `.aira/` during an update. A fresh Pterodactyl server does not automatically inherit data from an older server; transfer the existing data directory using the panel's supported file migration before switching traffic.

Embedded Chroma is used by default. The Python requirements include a bundled FFmpeg binary for animated GIF conversion, so the egg does not need to install FFmpeg through apt. A separate Chroma server is optional; set `CHROMA_URL` to its endpoint when using one. The repository's optional `docker-compose.yml` starts Chroma on loopback port 8000.

## Local development

```bash
python -m venv .venv
. .venv/bin/activate
python -m pip install -r requirements.txt
cp .env.example .env
# Start and paste the Discord bot token into the console when prompted:
python main.py
```

## Troubleshooting

- **Token prompt repeats:** make sure the hosting panel preserves the `.aira/discord.token` file across restarts. Do not delete or replace `.aira/` during an update.
- **Bot connects but ignores messages:** select the response channel in the Control Panel and enable Message Content Intent.
- **Gemini API key missing:** configure one through the Discord Control Panel or set `GEMINI_API_KEY`.
- **Memory is empty after migration:** confirm that the previous `.aira/chroma/` data was transferred; Chroma is not included in the Git repository.
- **Data disappears after redeploy:** configure persistent Pterodactyl storage for `.aira/` and avoid deleting it in Git deployment hooks.
- **Python dependency installation fails:** confirm that the server uses Python 3.13 and that the egg permits outbound package downloads.
