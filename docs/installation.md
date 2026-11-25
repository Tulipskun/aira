# Installation and first startup

## Requirements

- A Discord application and bot token.
- A host with Bash, `curl`, and `git`.
- Permission to install Bun (and `unzip` on Linux when it is not already installed). The installer uses the host package manager or Bun's official installer as appropriate.
- An invite to the target Discord server using the `bot` and `applications.commands` OAuth scopes.

## Install and start

The supported one-command installation for a public checkout is:

```bash
export DISCORD=YOUR_DISCORD_BOT_TOKEN
curl -fsSL https://github.com/Tulipskun/aira/raw/refs/heads/main/install.sh | bash
```

`DISCORD` is read by the installer and saved as `ISLA_TOKEN` in `~/.local/share/aira/.env`. The file is set to mode `0600`; the `.aira/` runtime directory is set to mode `0700`. Do not paste a real token into a shared terminal transcript or commit `.env`.

The installer clones the repository into `~/.local/share/aira`, or fast-forwards that checkout if it already exists. It preserves `.aira/`, installs dependencies from `bun.lock`, registers the `/isla` slash commands, then starts the supervisor. The supervisor waits for the Discord gateway health check; the installer exits with an error if the bot does not become ready. Re-running the same command updates and starts the existing installation.

To use a different install directory:

```bash
export AIRA_INSTALL_ROOT="$HOME/your/aira/path"
export DISCORD=YOUR_DISCORD_BOT_TOKEN
curl -fsSL https://github.com/Tulipskun/aira/raw/refs/heads/main/install.sh | bash
```

For an existing clone, export `DISCORD` and run `./install.sh` from the repository root.

## Discord setup

1. In the Discord Developer Portal, enable the Message Content privileged intent.
2. Invite the bot with the `bot` and `applications.commands` scopes.
3. Grant View Channels, Send Messages, Read Message History and Embed Links in the channels it will use.
4. After startup, find the `Aira • Control Panel` message. It is posted in the first guild text channel where the bot can view and send messages.
5. Use the panel as the Discord application owner to select the actual response channel. The panel's own channel is not automatically selected as the response channel.
6. Add one or more Gemini API keys and optionally change the Gemini 1, Gemini 2 and embedding model names.

The Control Panel also lets the application owner create/edit character definitions, aliases and prompts. Changes apply to subsequent turns.

## Runtime files

- `~/.local/share/aira/.env` — Discord token and optional environment overrides; mode `0600`.
- `~/.local/share/aira/.aira/settings.json` — Control Panel Gemini keys and model names; mode `0600`.
- `~/.local/share/aira/.aira/discord-config.json` — selected response channel.
- `~/.local/share/aira/.aira/aira.db` — SQLite history and structured user state.
- `~/.local/share/aira/.aira/chroma/` — Chroma vector data.
- `~/.local/share/aira/.aira/logs/` — runtime logs.

Keep `.env` and the entire `.aira/` directory private. They are runtime state and must not be committed or uploaded publicly.

## CLI operations

The installed CLI can be used from any directory:

```bash
aira status
aira stop
aira start
aira restart
aira log
```

`aira log` (also `aira logs`) prints the most recent 100 log lines. `aira setup` remains available for interactive configuration, but it is not required for the one-command install because the Discord Control Panel handles the normal first-run configuration. `aira update` pulls the latest Git revision and restarts an already-running installation when needed.
