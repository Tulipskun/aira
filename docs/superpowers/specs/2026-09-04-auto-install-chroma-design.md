# Automatic Python and Chroma Bootstrap Design

## Goal
Make `aira start` self-sufficient when the local Chroma CLI is missing, while keeping the existing local Chroma server/data layout and allowing environment variables to override Gemini model defaults.

## Decisions
- Gemini 1 default: `gemini-3.1-flash-lite`.
- Gemini 2 default: `gemini-3.5-flash-lite`.
- Chroma is installed through Python into Aira's private `.aira/chroma-venv` environment.
- If a compatible system Python is missing, the bootstrapper installs Python using the detected OS package manager.
- Supported package managers: `apt-get`, `dnf`, `pacman`, and `brew`; the first available appropriate manager is used.
- Debian/Ubuntu-style systems also install `python3-venv` when available so the private environment can be created.
- Existing `.aira/chroma-venv/bin/chroma` is reused; installation is idempotent.
- The supervisor ensures Chroma exists before spawning it, then performs the existing HTTP heartbeat check.
- Chroma data remains under `.aira/chroma/` and the default server remains `127.0.0.1:8000`.
- Bootstrap failures are fatal and produce an actionable error instead of starting a partially working bot.
- No global `pip install` is performed.
