# Aira

Discord AI character bot powered by Gemini and SQLite. Runtime: Python 3.13.

## Features

- One Discord bot with Isla and multiple configurable characters.
- Gemini 1 generates dialogue; Gemini 2 analyzes relationship state, facts and memory.
- Per-user relationship state and per-channel shared conversation context.
- SQLite conversation history, structured user state, semantic memory and episodic memory.
- Owner-only Discord Control Panel for Gemini keys/models, response channel and character prompts.
- Attachment understanding for images, audio, video, PDF and text.

## Deployment

Use a Python 3.13 egg/image and deploy https://github.com/Tulipskun/aira on main. Use the host's configured startup command to install requirements.txt and run main.py in the foreground.

No environment variables or .env file are required. On first start, paste the Discord bot token and Discord owner user ID into Console. Aira validates and saves them under .aira/discord.token and .aira/owner.id; later starts reuse them. Keep Console history private because the hosting panel may retain pasted input.

After login, run /aira to open the private owner-only panel. Configure Gemini API keys, model names, response channel and characters there. Panel settings are stored privately in .aira/settings.json.

Invite the bot with bot and applications.commands OAuth scopes. Grant View Channels, Send Messages, Read Message History, Embed Links and Attach Files. Enable Message Content Intent in the Discord Developer Portal.

## Persistent data

Keep .aira/ persistent across restarts and code updates. It contains aira.db, credentials, API keys, model settings, selected channel and key state. Do not delete or replace it during deployment.

Aira stores conversation history, semantic embeddings and episodic embeddings in the same SQLite database at .aira/aira.db. Semantic search uses cosine similarity in Python; no separate vector database, Chroma server, native extension, Node.js or Bun runtime is required.

If an older installation has .aira/chroma/, the new version attempts a one-time import when the Chroma package is still available in the existing runtime. Imported records are written to SQLite and the old Chroma files are retained. If Chroma is unavailable, the old files are left untouched and the new SQLite memory starts empty; do not delete .aira/chroma/ until the legacy data has been migrated or intentionally retired.

## Local run

    python -m venv .venv
    . .venv/bin/activate
    python -m pip install -r requirements.txt
    python main.py

On first launch, enter the Discord bot token and owner ID in Console. Add Gemini API keys in /aira after the bot connects.

## Discord command

- /aira — open the private owner-only admin panel.

After a slash-command schema change, the next startup replaces the global slash-command list with exactly /aira. Unknown prefix commands are ignored.

## Data and admin commands

Inspect history and memory with aira.cli. Destructive commands are dry-run by default; add --yes to execute.

Aira is licensed under AGPL-3.0-only.
