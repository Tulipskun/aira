from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path

from .config import ROOT


@dataclass(frozen=True)
class Character:
    id: str
    name: str
    aliases: tuple[str, ...]
    prompt_file: Path
    enabled: bool = True
    avatar_url: str | None = None


CHAR_DIR = ROOT / "characters"


def _validate(value: object, filename: str) -> Character:
    if not isinstance(value, dict):
        raise ValueError(f"Invalid character definition: {filename}")
    character_id = value.get("id")
    name = value.get("name")
    prompt = value.get("promptFile")
    if not isinstance(character_id, str) or not re.fullmatch(r"[a-z0-9_-]{1,32}", character_id):
        raise ValueError(f"Invalid character id: {filename}")
    if not isinstance(name, str) or not name.strip():
        raise ValueError(f"Invalid character name: {filename}")
    if not isinstance(prompt, str) or not prompt.strip():
        raise ValueError(f"Invalid promptFile: {filename}")
    aliases = value.get("aliases", [])
    aliases = [str(alias).strip() for alias in aliases if isinstance(alias, str) and alias.strip()] if isinstance(aliases, list) else []
    prompt_path = (CHAR_DIR / prompt).resolve()
    if prompt_path != ROOT and ROOT not in prompt_path.parents:
        raise ValueError(f"Character prompt escapes project directory: {filename}")
    avatar_url = value.get("avatarUrl")
    if avatar_url is not None and (not isinstance(avatar_url, str) or not avatar_url.startswith("https://")):
        raise ValueError(f"Invalid avatarUrl: {filename}")
    return Character(character_id, name.strip(), tuple([name.strip(), *aliases]), prompt_path,
                     value.get("enabled") is not False, avatar_url)


def load_characters() -> list[Character]:
    chars = []
    for path in sorted(CHAR_DIR.glob("*.json")):
        chars.append(_validate(json.loads(path.read_text("utf-8")), path.name))
    chars = [char for char in chars if char.enabled]
    ids: set[str] = set()
    names: set[str] = set()
    for char in chars:
        if char.id in ids:
            raise ValueError(f"Duplicate character id: {char.id}")
        ids.add(char.id)
        for alias in char.aliases:
            key = alias.casefold()
            if key in names:
                raise ValueError(f"Duplicate character alias: {alias}")
            names.add(key)
    if "isla" not in ids:
        raise ValueError("The Isla character definition is required")
    return chars


def load_character_prompt(character: Character) -> str:
    return character.prompt_file.read_text("utf-8").strip()


def character_session_key(session_key: str, character_id: str) -> str:
    return f"{session_key}:character:{character_id}"


def find_mentioned_characters(text: str, characters: list[Character]) -> list[Character]:
    value = text.casefold()
    return [char for char in characters if any(alias.casefold() in value for alias in char.aliases)]


def resolve_character_speakers(characters: list[Character], mentioned: list[Character],
                                selected_ids: list[str]) -> list[Character]:
    by_id = {char.id: char for char in characters}
    candidates = [*mentioned, *(by_id[key] for key in selected_ids if key in by_id)]
    selected = []
    seen = set()
    for char in candidates:
        if char.id not in seen:
            seen.add(char.id)
            selected.append(char)
    selected = selected[:2]
    if any(char.id == "isla" for char in selected):
        selected.sort(key=lambda char: char.id != "isla")
    return selected


def save_character(character_id: str, name: str, aliases: list[str], prompt: str, enabled: bool = True) -> None:
    if not re.fullmatch(r"[a-z0-9_-]{1,32}", character_id) or not name.strip():
        raise ValueError("Invalid character id or name")
    if not prompt.strip():
        raise ValueError("Character prompt cannot be empty")
    active = [c for c in load_characters() if c.id != character_id]
    names = {a.casefold() for c in active for a in c.aliases}
    for alias in [name, *aliases]:
        if alias.casefold() in names:
            raise ValueError(f"Character alias already in use: {alias}")
    if character_id == "isla" and not enabled:
        raise ValueError("Isla cannot be disabled")
    prompt_dir = CHAR_DIR / "prompts"
    prompt_dir.mkdir(parents=True, exist_ok=True)
    (prompt_dir / f"{character_id}.md").write_text(prompt.strip() + "\n", encoding="utf-8")
    previous_path = CHAR_DIR / f"{character_id}.json"
    previous = json.loads(previous_path.read_text("utf-8")) if previous_path.is_file() else {}
    definition = {
        "id": character_id, "name": name.strip(), "aliases": aliases,
        "promptFile": f"prompts/{character_id}.md", "enabled": enabled,
    }
    if isinstance(previous.get("avatarUrl"), str) and previous["avatarUrl"].startswith("https://"):
        definition["avatarUrl"] = previous["avatarUrl"]
    (CHAR_DIR / f"{character_id}.json").write_text(
        json.dumps(definition, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
