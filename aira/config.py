from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def _load_panel_settings() -> dict:
    path = ROOT / ".aira" / "settings.json"
    try:
        return json.loads(path.read_text("utf-8"))
    except (OSError, ValueError):
        return {}


def _env_or_setting(env: str, setting: str, default: str) -> str:
    return os.getenv(env) or str(_load_panel_settings().get(setting) or default)


def _load_discord_token() -> str:
    try:
        token = (ROOT / ".aira" / "discord.token").read_text("utf-8").strip()
        if token:
            return token
    except OSError:
        pass
    return os.getenv("DISCORD", "").strip()


def _split_keys(value: str) -> list[str]:
    return [part.strip() for part in value.split(",") if part.strip()]


def _resolve_path(value: str) -> Path:
    path = Path(value).expanduser()
    return path if path.is_absolute() else (ROOT / path).resolve()


@dataclass
class Config:
    discord_token: str = field(default_factory=_load_discord_token)
    owner_id: str = field(default_factory=lambda: os.getenv("DISCORD_OWNER_ID", "").strip())
    response_channel_id: str = field(default_factory=lambda: os.getenv("DISCORD_RESPONSE_CHANNEL_ID", "").strip())
    gemini_keys: list[str] = field(default_factory=lambda: _split_keys(
        os.getenv("GEMINI_API_KEY") or str(_load_panel_settings().get("geminiApiKeys") or "")
        or os.getenv("GEMINI1_API_KEYS") or os.getenv("GEMINI2_API_KEYS") or os.getenv("GEMINI_EMBEDDING2_API_KEYS") or ""))
    gemini1_keys: list[str] = field(default_factory=lambda: _split_keys(os.getenv("GEMINI1_API_KEYS") or os.getenv("GEMINI_API_KEY") or str(_load_panel_settings().get("geminiApiKeys") or "")))
    gemini2_keys: list[str] = field(default_factory=lambda: _split_keys(os.getenv("GEMINI2_API_KEYS") or os.getenv("GEMINI_API_KEY") or str(_load_panel_settings().get("geminiApiKeys") or "")))
    embedding_keys: list[str] = field(default_factory=lambda: _split_keys(os.getenv("GEMINI_EMBEDDING2_API_KEYS") or os.getenv("GEMINI_API_KEY") or str(_load_panel_settings().get("geminiApiKeys") or "")))
    gemini1_model: str = field(default_factory=lambda: _env_or_setting("GEMINI1_MODEL", "gemini1Model", "gemini-3.1-flash-lite"))
    gemini2_model: str = field(default_factory=lambda: _env_or_setting("GEMINI2_MODEL", "gemini2Model", "gemini-3.5-flash-lite"))
    embedding_model: str = field(default_factory=lambda: _env_or_setting("GEMINI_EMBEDDING2_MODEL", "embeddingModel", "gemini-embedding-2"))
    embedding_dimension: int = field(default_factory=lambda: int(os.getenv("GEMINI_EMBEDDING2_DIMENSION", "768")))
    sqlite_path: Path = field(default_factory=lambda: _resolve_path(os.getenv("SQLITE_PATH", "./.aira/aira.db")))
    chroma_url: str = field(default_factory=lambda: os.getenv("CHROMA_URL", "").strip())
    chroma_path: Path = field(default_factory=lambda: _resolve_path(os.getenv("CHROMA_PATH", "./.aira/chroma")))
    chroma_collection: str = field(default_factory=lambda: os.getenv("CHROMA_COLLECTION", "aira_memories"))
    episode_collection: str = field(default_factory=lambda: os.getenv("ISLA_EPISODE_COLLECTION", "aira_episodes"))
    timezone: str = field(default_factory=lambda: os.getenv("ISLA_TIMEZONE", "Asia/Bangkok"))
    health_port: int = field(default_factory=lambda: int(os.getenv("ISLA_HEALTH_PORT", "8091")))
    images_dir: Path = field(default_factory=lambda: _resolve_path(os.getenv("ISLA_IMAGES_DIR", "./images")))
    gemini1_prompt: Path = field(default_factory=lambda: _resolve_path(os.getenv("GEMINI1_SYSTEM_PROMPT_FILE", "./prompts/isla.md")))
    gemini2_prompt: Path = field(default_factory=lambda: _resolve_path(os.getenv("GEMINI2_SYSTEM_PROMPT_FILE", "./prompts/isla-state.md")))
    key_state_file: Path = field(default_factory=lambda: _resolve_path(os.getenv("GEMINI_KEY_STATE_FILE", "./.aira/gemini-key-state.json")))
    thought_state_file: Path = field(default_factory=lambda: _resolve_path(os.getenv("GEMINI_THOUGHT_SIGNATURE_FILE", "./.aira/gemini-thought-signatures.json")))
    memory_max_results: int = field(default_factory=lambda: int(os.getenv("ISLA_MEMORY_MAX_RESULTS", "8")))
    memory_min_similarity: float = field(default_factory=lambda: float(os.getenv("ISLA_MEMORY_MIN_SIMILARITY", "0.6")))
    memory_dedupe_similarity: float = field(default_factory=lambda: float(os.getenv("ISLA_MEMORY_DEDUPE_SIMILARITY", "0.92")))
    episode_max_results: int = field(default_factory=lambda: int(os.getenv("ISLA_EPISODE_MAX_RESULTS", "5")))
    episode_min_similarity: float = field(default_factory=lambda: float(os.getenv("ISLA_EPISODE_MIN_SIMILARITY", "0.55")))
    episode_gap_minutes: int = field(default_factory=lambda: int(os.getenv("ISLA_EPISODE_GAP_MINUTES", "30")))
    debug_payload: bool = field(default_factory=lambda: os.getenv("GEMINI_DEBUG_PAYLOAD", "0").lower() in {"1", "true", "yes", "on"})
    debug_payload_file: Path = field(default_factory=lambda: _resolve_path(os.getenv("GEMINI_DEBUG_PAYLOAD_FILE", "./.aira/logs/gemini-payload.json")))

    def validate(self) -> None:
        if not self.discord_token:
            raise RuntimeError("Discord token is missing; start main.py and enter it in the console")
        self.sqlite_path.parent.mkdir(parents=True, exist_ok=True)
        self.chroma_path.mkdir(parents=True, exist_ok=True)
        self.key_state_file.parent.mkdir(parents=True, exist_ok=True)


def load_settings() -> dict:
    return _load_panel_settings()


def save_settings(settings: dict) -> None:
    path = ROOT / ".aira" / "settings.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".json.tmp")
    temporary.write_text(json.dumps(settings, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    try:
        temporary.chmod(0o600)
    except OSError:
        pass
    temporary.replace(path)
    try:
        path.chmod(0o600)
    except OSError:
        pass


config = Config()
