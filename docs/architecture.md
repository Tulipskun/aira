# Architecture

The runtime is Python 3.13. Pterodactyl starts `main.py` in the foreground; Discord's gateway lifecycle is owned by `discord.py`. No Node.js or Bun runtime is required.

- `main.py`: environment loading, secure logging, startup and signal handling.
- `aira/discord_app.py`: Discord gateway, slash commands, owner-only Control Panel, RPS views, message dispatch and local health endpoint.
- `aira/scheduler.py`: per-session debounce, bounded wait and flush queue.
- `aira/pipeline.py`: orchestration of user and character turns.
- `aira/gemini.py`: Gemini interactions, structured output, key rotation and prompt parsing.
- `aira/memory.py`: Chroma semantic and episodic memory.
- `aira/store.py`: SQLite persistence and atomic/idempotent state updates.
- `aira/relationships.py`: relationship ladder and permission rules.
- `aira/characters.py`: character definitions, prompts and selection.
- `aira/media.py`: safe attachment download, MIME detection and image preprocessing.
- `aira/liveness.py`: gateway/queue activity and health metrics.
- `aira/warmup.py`: bounded DNS/HTTPS warm-up before connecting the Discord gateway.
- `aira/register_commands.py`: explicit global command registration that preserves unrelated application commands.

SQLite is authoritative for conversation history and structured user state. Chroma is a retrieval index for long-term semantic and episodic memories. Chroma writes run outside the response-critical SQLite transaction and are best-effort.

Runtime state is stored under `.aira/`, which is Git-ignored. The bot runs as a single foreground process; Pterodactyl handles process supervision and restarts.
