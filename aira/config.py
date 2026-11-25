from __future__ import annotations
import json
from dataclasses import dataclass, field
from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]
SETTINGS_PATH = ROOT / ".aira" / "settings.json"
def _load_panel_settings() -> dict:
    try:
        value = json.loads(SETTINGS_PATH.read_text("utf-8"))
        return value if isinstance(value, dict) else {}
    except (OSError, ValueError): return {}
def _setting(key: str, default): return _load_panel_settings().get(key, default)
def _model_setting(key: str, default: str, legacy_defaults: tuple[str, ...]) -> str:
    value = str(_setting(key, default)).strip()
    return default if value in legacy_defaults else value
def _split_keys(value) -> list[str]:
    if isinstance(value, list): return [str(x).strip() for x in value if str(x).strip()]
    return [x.strip() for x in str(value or "").split(",") if x.strip()]
def _resolve_path(value: str) -> Path:
    path = Path(value).expanduser()
    return path if path.is_absolute() else (ROOT / path).resolve()
def _load_owner_id() -> str:
    try: return (ROOT / ".aira" / "owner.id").read_text("utf-8").strip()
    except OSError: return ""
def _load_discord_token() -> str:
    try: return (ROOT / ".aira" / "discord.token").read_text("utf-8").strip()
    except OSError: return ""
@dataclass
class Config:
    discord_token: str = field(default_factory=_load_discord_token)
    owner_id: str = field(default_factory=_load_owner_id)
    chroma_collection: str = "aira_memories"
    episode_collection: str = "aira_episodes"
    response_channel_id: str = ""
    gemini_keys: list[str] = field(default_factory=lambda: _split_keys(_setting("geminiApiKeys", [])))
    gemini1_keys: list[str] = field(default_factory=lambda: _split_keys(_setting("gemini1ApiKeys", _setting("geminiApiKeys", []))))
    gemini2_keys: list[str] = field(default_factory=lambda: _split_keys(_setting("gemini2ApiKeys", _setting("geminiApiKeys", []))))
    embedding_keys: list[str] = field(default_factory=lambda: _split_keys(_setting("embeddingApiKeys", _setting("geminiApiKeys", []))))
    gemini1_model: str = field(default_factory=lambda: _model_setting("gemini1Model", "gemini-3.8-flash", ("gemini-3.1-flash-lite",)))
    gemini2_model: str = field(default_factory=lambda: _model_setting("gemini2Model", "gemini-3.8-flash", ("gemini-3.5-flash-lite",)))
    embedding_model: str = field(default_factory=lambda: str(_setting("embeddingModel", "gemini-embedding-2")))
    embedding_dimension: int = field(default_factory=lambda: int(_setting("embeddingDimension", 768)))
    sqlite_path: Path = field(default_factory=lambda: _resolve_path(".aira/aira.db"))
    timezone: str = field(default_factory=lambda: str(_setting("timezone", "Asia/Bangkok")))
    health_port: int = 8091
    images_dir: Path = field(default_factory=lambda: _resolve_path("images"))
    gemini1_prompt: Path = field(default_factory=lambda: _resolve_path("prompts/isla.md"))
    gemini2_prompt: Path = field(default_factory=lambda: _resolve_path("prompts/isla-state.md"))
    key_state_file: Path = field(default_factory=lambda: _resolve_path(".aira/gemini-key-state.json"))
    thought_state_file: Path = field(default_factory=lambda: _resolve_path(".aira/gemini-thought-signatures.json"))
    memory_max_results: int = field(default_factory=lambda: int(_setting("memoryMaxResults", 8)))
    memory_min_similarity: float = field(default_factory=lambda: float(_setting("memoryMinSimilarity", 0.6)))
    memory_dedupe_similarity: float = field(default_factory=lambda: float(_setting("memoryDedupeSimilarity", 0.92)))
    episode_max_results: int = field(default_factory=lambda: int(_setting("episodeMaxResults", 5)))
    episode_min_similarity: float = field(default_factory=lambda: float(_setting("episodeMinSimilarity", 0.55)))
    episode_gap_minutes: int = field(default_factory=lambda: int(_setting("episodeGapMinutes", 30)))
    debug_payload: bool = field(default_factory=lambda: bool(_setting("debugPayload", False)))
    debug_payload_file: Path = field(default_factory=lambda: _resolve_path(".aira/logs/gemini-payload.json"))
    def validate(self) -> None:
        if not self.discord_token: raise RuntimeError("Discord token is missing; start main.py and enter it in the console")
        self.sqlite_path.parent.mkdir(parents=True, exist_ok=True)
        self.key_state_file.parent.mkdir(parents=True, exist_ok=True)
def load_settings() -> dict: return _load_panel_settings()
def save_settings(settings: dict) -> None:
    path = SETTINGS_PATH
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".json.tmp")
    temporary.write_text(json.dumps(settings, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    try: temporary.chmod(0o600)
    except OSError: pass
    temporary.replace(path)
    try: path.chmod(0o600)
    except OSError: pass
config = Config()
