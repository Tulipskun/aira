# Installation and deployment

## Pterodactyl Python 3.13

1. Create a server using a Python 3.13 egg/image.
2. Deploy https://github.com/Tulipskun/aira on main, preserving the writable .aira/ data directory.
3. Use the host's configured startup command to install requirements.txt and run main.py in the foreground.
4. On first start, paste the Discord bot token and your Discord user ID into Console. Aira verifies and saves them in .aira/discord.token and .aira/owner.id; later starts reuse both.
5. Run /aira in Discord. Use the owner-only panel to configure Gemini API keys, model names, response channel and characters.
6. Enable Message Content Intent in the Discord Developer Portal. Invite the bot with bot and applications.commands scopes and grant View Channels, Send Messages, Read Message History, Embed Links and Attach Files.

Environment variables and .env are not used. Keep Console history private because hosting panels may retain pasted input.

Pterodactyl manages the foreground process. Do not wrap main.py in a daemon or shell installer.

## Persistent storage and upgrades

Keep these paths persistent:
- .aira/aira.db — conversation history, structured state, semantic and episodic vector memories.
- .aira/settings.json — API keys and model settings saved from Discord.
- .aira/discord-config.json — selected response channel.
- .aira/discord.token and .aira/owner.id — verified credentials with owner-only file permissions.

Do not delete or replace .aira/ during an update.

Older installations may have .aira/chroma/. The new runtime tries to import the old Chroma collections once if the Chroma Python package is still present. It retains the old files after a successful import. If the package is unavailable, it logs a warning and leaves the legacy files untouched; SQLite memory then starts empty. Keep the legacy directory until migration is confirmed or the data is no longer needed.

## Local development

    python -m venv .venv
    . .venv/bin/activate
    python -m pip install -r requirements.txt
    python main.py

## Troubleshooting

- Token prompt repeats: ensure .aira/discord.token persists across restarts.
- Bot connects but ignores messages: select the response channel in /aira and enable Message Content Intent.
- Gemini API key missing: add one through /aira.
- Memory appears empty: check startup logs for the legacy Chroma migration warning. Do not delete .aira/chroma/ until old records are imported.
- Data disappears after redeploy: preserve .aira/ in the host's persistent storage.
