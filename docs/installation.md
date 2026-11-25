# Installation and first startup

## Pterodactyl (recommended)

Deploy Aira from its public Git repository using the panel's Git settings. No shell installer or curl pipe is required.

Configure Startup / Environment Variables:

| Variable | Value |
| --- | --- |
| GIT_ADDRESS | https://github.com/Tulipskun/aira |
| BRANCH | main |
| USER_UPLOAD | 0 |
| AUTO_UPDATE | 1 |
| NODE_PACKAGES | bun |
| DISCORD | Your Discord bot token |

Set the startup command to node index.js. The egg must install NODE_PACKAGES before startup so Bun is available on PATH. Aira uses Bun APIs, including bun:sqlite; a plain Node.js runtime is not sufficient.

On startup, index.js installs locked dependencies, registers Discord slash commands, and launches Aira in the foreground. Logs remain attached to the Pterodactyl console. Use the panel controls to stop or restart the bot.

Keep DISCORD private. Do not put the token in Git, the repository URL, or uploaded files. Gemini API keys and character configuration can be managed from the Discord Control Panel after startup.

## Requirements

- A Discord application and bot token.
- A Pterodactyl Node.js egg with Git repository deployment support.
- Bun installed by the egg before the startup command runs.
- An invite to the target Discord server using the bot and applications.commands OAuth scopes.

## Discord setup

1. In the Discord Developer Portal, enable the Message Content privileged intent.
2. Invite the bot with the bot and applications.commands scopes.
3. Grant View Channels, Send Messages, Read Message History and Embed Links in the channels it will use.
4. After startup, find the Aira Control Panel message. It is posted in the first guild text channel where the bot can view and send messages.
5. Use the panel as the Discord application owner to select the actual response channel.
6. Add one or more Gemini API keys and optionally change model names.

The Control Panel also lets the application owner create/edit character definitions, aliases and prompts. Changes apply to subsequent turns.

## Runtime files

- .aira/settings.json — Control Panel Gemini keys and model names; keep private.
- .aira/discord-config.json — selected response channel.
- .aira/aira.db — SQLite history and structured user state.
- .aira/chroma/ — Chroma vector data.
- .aira/logs/ — runtime logs.

Keep the entire .aira/ directory private. It contains runtime state and must not be committed or uploaded publicly.

## CLI operations

For a manually managed Bun checkout, these commands remain available:

    bun run start
    bun run stop
    bun run logs
