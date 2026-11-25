from __future__ import annotations

import asyncio
import logging
import os
import sys
from logging.handlers import RotatingFileHandler
from pathlib import Path


ROOT = Path(__file__).resolve().parent
os.chdir(ROOT)
os.umask(0o077)


def configure_logging() -> None:
    runtime_dir = ROOT / ".aira"
    runtime_dir.mkdir(parents=True, exist_ok=True)
    log_path = runtime_dir / "aira.log"
    handlers: list[logging.Handler] = [logging.StreamHandler(sys.stdout)]
    try:
        file_handler = RotatingFileHandler(log_path, maxBytes=10 * 1024 * 1024, backupCount=5, encoding="utf-8")
        os.chmod(log_path, 0o600)
        handlers.append(file_handler)
    except OSError as exc:
        print(f"[LOG] file logging unavailable: {exc}", file=sys.stderr)
    logging.basicConfig(
        level=os.getenv("LOG_LEVEL", "INFO").upper(),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
        handlers=handlers,
        force=True,
    )


def main() -> int:
    try:
        try:
            from dotenv import load_dotenv
        except ImportError:
            load_dotenv = None
        if load_dotenv is not None:
            load_dotenv(ROOT / ".env", override=False)
        configure_logging()
        from aira.discord_auth import get_discord_token
        os.environ["DISCORD"] = get_discord_token()
        from aira.config import config

        # Update the global /isla command definition once per schema version.
        # The registrar merges commands and preserves unrelated application commands.
        command_version = "channel-sessions-v1"
        command_marker = ROOT / ".aira" / "discord-commands-version"
        try:
            current_version = command_marker.read_text("utf-8").strip()
        except OSError:
            current_version = ""
        if current_version != command_version:
            try:
                from aira.register_commands import register_commands
                asyncio.run(register_commands(config.discord_token))
                temporary_marker = command_marker.with_suffix(".tmp")
                temporary_marker.write_text(command_version + "\\n", encoding="utf-8")
                os.chmod(temporary_marker, 0o600)
                temporary_marker.replace(command_marker)
                logging.getLogger("aira").info("Discord slash commands updated")
            except Exception:
                logging.getLogger("aira").warning(
                    "Discord slash-command update failed; it will retry on the next start",
                    exc_info=True,
                )

        from aira.discord_app import run_bot
        if not config.gemini_keys:
            logging.getLogger("aira").warning(
                "GEMINI_API_KEY is not set; add it through the Aira Control Panel after the bot starts"
            )
        config.sqlite_path.parent.mkdir(parents=True, exist_ok=True)
        config.chroma_path.mkdir(parents=True, exist_ok=True)
        logging.getLogger("aira").info(
            "Starting Aira Python %s | Python %s | SQLite %s | Chroma %s",
            __import__("aira").__version__, sys.version.split()[0], config.sqlite_path,
            config.chroma_url or config.chroma_path,
        )
        asyncio.run(run_bot())
        return 0
    except KeyboardInterrupt:
        logging.getLogger("aira").info("Shutdown requested")
        return 0
    except Exception:
        logging.exception("Aira startup/runtime failure")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
