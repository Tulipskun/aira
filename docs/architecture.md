# Architecture

The runtime is Python 3.13. Pterodactyl starts main.py in the foreground; Discord's gateway lifecycle is owned by discord.py. No Node.js, Bun runtime, Chroma server, environment variables or .env file are required.

- main.py: secure logging, credential prompt, startup and signal handling.
- aira/discord_app.py: Discord gateway, owner-only /aira Control Panel, message dispatch and local health endpoint.
- aira/scheduler.py: per-session debounce and bounded flush queue.
- aira/pipeline.py: speaker selection, shared room context, character turns and isolated memory retrieval.
- aira/gemini.py: social speaker scheduling, character dialogue, structured output, key rotation and prompt parsing.
- aira/memory.py: SQLite semantic and episodic memory with Python cosine similarity.
- aira/store.py: SQLite persistence and atomic/idempotent state updates.
- aira/relationships.py: relationship ladder and permission rules.
- aira/characters.py: character definitions, prompts and selection.
- aira/media.py: safe attachment download, MIME detection and image preprocessing.
- aira/liveness.py: gateway/queue activity and health metrics.

SQLite is authoritative for shared room history, per-user state, per-character semantic/episodic memories and directed character-to-character relationship perspectives. Each selected character receives the same public room history but retrieves only its own long-term memories. Runtime settings and secrets are stored under .aira/, which is Git-ignored. The bot runs as a single foreground process; Pterodactyl handles process supervision and restarts.
