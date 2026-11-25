from __future__ import annotations

import json
import logging
import os
import re
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .config import config

log = logging.getLogger("aira.gemini.debug")
MAX_RECORDS = 6
MAX_STRING_CHARS = 80_000
_warned_at = 0.0


def _redact(value: Any, depth: int = 0) -> Any:
    if depth > 12:
        return "[truncated]"
    if isinstance(value, str):
        value = re.sub(r"AIza[0-9A-Za-z_-]{20,}", "[redacted-api-key]", value)
        value = re.sub(r"(?i)(?:Bot|Bearer)\s+[A-Za-z0-9._-]{20,}", "[redacted-authorization]", value)
        return value if len(value) <= MAX_STRING_CHARS else value[:MAX_STRING_CHARS] + "[truncated]"
    if isinstance(value, (list, tuple)):
        return [_redact(item, depth + 1) for item in value]
    if isinstance(value, dict):
        result = {}
        for key, item in value.items():
            name = str(key)
            if re.search(r"api[-_]?key|token|secret|authorization", name, re.I):
                result[name] = "[redacted]"
            elif name == "signature" and isinstance(item, str):
                result[name] = item[:12] + f"…({len(item)})"
            else:
                result[name] = _redact(item, depth + 1)
        return result
    if hasattr(value, "model_dump"):
        return _redact(value.model_dump(by_alias=True, exclude_none=True), depth + 1)
    if hasattr(value, "__dict__"):
        return _redact(vars(value), depth + 1)
    if value is None or isinstance(value, (int, float, bool)):
        return value
    return str(value)


def _path() -> Path:
    return Path(config.debug_payload_file)


def read_debug_dump(path: Path | None = None) -> list[dict]:
    target = path or _path()
    try:
        data = json.loads(target.read_text("utf-8"))
    except (OSError, ValueError):
        return []
    return data if isinstance(data, list) else []


def debug_dump(record: dict) -> None:
    global _warned_at
    if not config.debug_payload:
        return
    path = _path()
    try:
        records = read_debug_dump(path)
        records.append(_redact({
            "ts": datetime.now(timezone.utc).isoformat(),
            **record,
        }))
        path.parent.mkdir(parents=True, exist_ok=True)
        temp = path.with_name(path.name + f".tmp-{os.getpid()}")
        temp.write_text(json.dumps(records[-MAX_RECORDS:], ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        try:
            temp.chmod(0o600)
        except OSError:
            pass
        temp.replace(path)
        try:
            path.chmod(0o600)
        except OSError:
            pass
    except (OSError, TypeError, ValueError):
        now = time.monotonic()
        if now - _warned_at >= 60:
            _warned_at = now
            log.exception("Could not write optional Gemini debug payload dump")


def debug_dump_enabled() -> bool:
    return bool(config.debug_payload)
