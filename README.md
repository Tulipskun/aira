# Aira

Discord AI character bot powered by Gemini and SQLite. Runtime: Python 3.13.

## Features

- One Discord bot with Isla and multiple configurable characters.
- Gemini 1 generates character dialogue; Gemini 2 selects speakers and analyzes relationship state, facts and memory.
- Multi-user group chats with a social speaker scheduler: characters may stay silent or join when relevant.
- Up to two characters can speak in the same turn, including Rem, Bocchi and Origami together without Isla; direct mentions take priority.
- Each character has isolated semantic/episodic memories and its own perspective on other characters.
- Shared per-channel conversation history, per-user relationship state and SQLite long-term memory.
- Owner-only Discord Control Panel for Gemini keys/models, response channel and character prompts.
- Attachment understanding for images, audio, video, PDF and text.

## Deployment

Use a Python 3.13 egg/image and deploy https://github.com/Tulipskun/aira on main. Use the host's configured startup command to install requirements.txt and run main.py in the foreground.

No environment variables or .env file are required. On first start, paste the Discord bot token and Discord owner user ID into Console. Aira validates and saves them under .aira/discord.token and .aira/owner.id; later starts reuse them. Keep Console history private because the hosting panel may retain pasted input.

After login, run /aira to open the private owner-only panel. Configure Gemini API keys, model names, response channel and characters there. Panel settings are stored privately in .aira/settings.json.

Invite the bot with bot and applications.commands OAuth scopes. Grant View Channels, Send Messages, Read Message History, Embed Links, Attach Files and Manage Webhooks. Aira uses one reusable webhook per character and response channel so each character has its own display name and avatar. Enable Message Content Intent in the Discord Developer Portal.

## Persistent data

Keep .aira/ persistent across restarts and code updates. It contains aira.db, credentials, API keys, model settings, selected channel and key state. Do not delete or replace it during deployment.

On the first startup of this release, Aira performs the approved one-time fresh-memory reset before importing any legacy memory: conversation history, user profiles/facts, character-to-user and character-to-character relationships, semantic/episodic memories, legacy Chroma vectors and saved Gemini thought signatures are erased. Discord credentials, owner ID, API keys, model settings and selected response channel are preserved. The .aira/fresh-memory-v1 marker makes the reset idempotent; later restarts do not erase newly created memories.

Aira stores conversation history, semantic embeddings and episodic embeddings in the same SQLite database at .aira/aira.db. Semantic search uses cosine similarity in Python; no separate vector database, Chroma server, native extension, Node.js or Bun runtime is required.

Legacy .aira/chroma/ files are intentionally deleted by the approved fresh-memory reset before the legacy importer can run. The reset also creates the Chroma migration marker so erased vectors cannot be imported again.

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
