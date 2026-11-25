from __future__ import annotations

import getpass
import json
import os
import tempfile
from pathlib import Path
from typing import Callable, Mapping
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
TOKEN_PATH = ROOT / ".aira" / "discord.token"
DISCORD_ME_URL = "https://discord.com/api/v10/users/@me"


class InvalidDiscordToken(Exception):
    """Raised when Discord explicitly rejects a bot token."""


def validate_discord_token(token: str, opener: Callable | None = None) -> None:
    """Verify a bot token with Discord without ever including it in an error."""
    if not token or any(character.isspace() for character in token):
        raise InvalidDiscordToken
    request = Request(
        DISCORD_ME_URL,
        headers={"Authorization": f"Bot {token}", "User-Agent": "Aira/1.0"},
        method="GET",
    )
    open_request = opener or urlopen
    try:
        response = open_request(request, timeout=15)
        try:
            payload = json.loads(response.read().decode("utf-8"))
        finally:
            close = getattr(response, "close", None)
            if close:
                close()
    except HTTPError as exc:
        if exc.code == 401:
            raise InvalidDiscordToken from None
        raise RuntimeError(f"Discord token verification failed (HTTP {exc.code})") from None
    except (URLError, TimeoutError, OSError) as exc:
        raise RuntimeError(f"Could not reach Discord to verify the token: {exc.__class__.__name__}") from None
    except (UnicodeDecodeError, json.JSONDecodeError, AttributeError):
        raise RuntimeError("Discord returned an unreadable token-verification response") from None

    if not isinstance(payload, dict) or payload.get("bot") is not True or not payload.get("id"):
        raise InvalidDiscordToken


def load_saved_token(token_path: Path = TOKEN_PATH) -> str:
    try:
        return token_path.read_text(encoding="utf-8").strip()
    except FileNotFoundError:
        return ""
    except OSError:
        raise RuntimeError("Cannot read the saved Discord token from .aira/discord.token") from None


def save_token(token: str, token_path: Path = TOKEN_PATH) -> None:
    """Atomically save a verified token with owner-only file and directory permissions."""
    parent = token_path.parent
    parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(parent, 0o700)

    fd, temporary_name = tempfile.mkstemp(prefix=".discord-token-", dir=parent)
    temporary_path = Path(temporary_name)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            stream.write(token + "\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary_path, token_path)
        os.chmod(token_path, 0o600)
    except Exception:
        try:
            os.close(fd)
        except OSError:
            pass
        try:
            temporary_path.unlink()
        except OSError:
            pass
        raise


def get_discord_token(
    token_path: Path = TOKEN_PATH,
    environ: Mapping[str, str] | None = None,
    prompt: Callable[[str], str] | None = None,
    validator: Callable[[str], None] = validate_discord_token,
    notify: Callable[[str], None] = print,
) -> str:
    """Load a saved token, migrate a legacy DISCORD variable, or prompt once."""
    env = os.environ if environ is None else environ
    read_saved = load_saved_token(token_path)

    if read_saved:
        try:
            validator(read_saved)
            return read_saved
        except InvalidDiscordToken:
            notify("The saved Discord token was rejected. Enter a replacement token.")

    legacy = str(env.get("DISCORD", "")).strip()
    if legacy and legacy != read_saved:
        try:
            validator(legacy)
        except InvalidDiscordToken:
            notify("The legacy DISCORD token was rejected. Enter a valid bot token.")
        else:
            save_token(legacy, token_path)
            notify("Discord token verified and saved for future starts.")
            return legacy

    read_secret = prompt or getpass.getpass
    while True:
        try:
            token = read_secret("Discord Bot Token: ").strip()
        except (EOFError, KeyboardInterrupt):
            raise RuntimeError("No Discord token was entered; startup cancelled") from None
        if not token:
            notify("Token cannot be empty. Please try again.")
            continue
        try:
            validator(token)
        except InvalidDiscordToken:
            notify("Discord rejected that token. Check it and try again.")
            continue
        save_token(token, token_path)
        notify("Discord token verified and saved for future starts.")
        return token


OWNER_ID_PATH = ROOT / ".aira" / "owner.id"


def get_discord_owner_id(owner_path: Path = OWNER_ID_PATH, environ: Mapping[str, str] | None = None,
                         prompt: Callable[[str], str] | None = None,
                         notify: Callable[[str], None] = print) -> str:
    """Load the owner ID or ask for it once in the server console."""
    env = os.environ if environ is None else environ
    try:
        saved = owner_path.read_text(encoding="utf-8").strip()
    except FileNotFoundError:
        saved = ""
    except OSError:
        raise RuntimeError("Cannot read .aira/owner.id") from None
    value = saved or str(env.get("DISCORD_OWNER_ID", "")).strip()
    if not value:
        reader = prompt or input
        while True:
            try:
                value = reader("Discord Owner User ID: ").strip()
            except (EOFError, KeyboardInterrupt):
                raise RuntimeError("No Discord owner ID was entered; startup cancelled") from None
            if value.isdigit() and 17 <= len(value) <= 20:
                break
            notify("Enter a valid Discord user ID (17–20 digits).")
    if not value.isdigit() or not 17 <= len(value) <= 20:
        raise RuntimeError("Saved Discord owner ID is invalid; correct .aira/owner.id")
    if not saved:
        parent = owner_path.parent
        parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        os.chmod(parent, 0o700)
        fd, temporary_name = tempfile.mkstemp(prefix=".owner-id-", dir=parent)
        temporary_path = Path(temporary_name)
        try:
            os.fchmod(fd, 0o600)
            with os.fdopen(fd, "w", encoding="utf-8") as stream:
                stream.write(value + "\n")
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary_path, owner_path)
            os.chmod(owner_path, 0o600)
        except Exception:
            try:
                os.close(fd)
            except OSError:
                pass
            temporary_path.unlink(missing_ok=True)
            raise
        notify("Discord owner ID saved for future starts.")
    return value
