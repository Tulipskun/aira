from __future__ import annotations

import asyncio
import json
import logging
import os
import uuid
from pathlib import Path

from .config import config

log = logging.getLogger("aira.gemini.signatures")
MAX_POOL_SIZE = 5
BOOTSTRAP_SIGNATURE = "El4KXAERTTIPV5DSwWOxBfzxqrZ7KbEV9e9KtO4jGvcB6fuuTxysDRrjCc+qdvx4lAPLBxk1qBtDEvIfZpovKWuoS8XqngT1bXfW4W0Bar04RyQJbG7rvweMa71A1cCR"


def _load() -> list[str]:
    values = [item.strip() for item in os.getenv("GEMINI1_THOUGHT_SIGNATURE", "").split(",") if item.strip()]
    try:
        state = json.loads(config.thought_state_file.read_text("utf-8"))
        saved = state.get("signatures", []) if isinstance(state, dict) else []
        if isinstance(saved, list):
            values.extend(item for item in saved if isinstance(item, str) and item)
    except (OSError, ValueError, TypeError):
        pass
    return list(dict.fromkeys(values))[-MAX_POOL_SIZE:]


_pool = _load()
_cursor = 0
_dirty = False
_flush_task: asyncio.Task | None = None


def active_pool() -> list[str]:
    return list(_pool or [BOOTSTRAP_SIGNATURE])


def next_thought_signature() -> str:
    global _cursor, _flush_task
    values = active_pool()
    signature = values[_cursor % len(values)]
    _cursor = (_cursor + 1) % len(values)
    _schedule_flush()
    return signature


def _schedule_flush() -> None:
    global _flush_task
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return
    if _flush_task and not _flush_task.done():
        _flush_task.cancel()

    async def later():
        try:
            await asyncio.sleep(600)
            flush_thought_signatures()
        except asyncio.CancelledError:
            return

    _flush_task = loop.create_task(later())


def add_thought_signature(signature: str | None) -> None:
    global _dirty, _cursor
    if not signature or signature in _pool:
        _schedule_flush()
        return
    _pool.append(signature)
    del _pool[:-MAX_POOL_SIZE]
    _cursor %= len(_pool)
    _dirty = True
    _schedule_flush()


def invalidate_thought_signature(signature: str | None) -> None:
    global _dirty, _cursor
    if not signature or signature not in _pool:
        _schedule_flush()
        return
    _pool.remove(signature)
    _cursor = _cursor % len(_pool) if _pool else 0
    _dirty = True
    _schedule_flush()


def rotate_thought_signatures(steps: list[dict]) -> list[dict] | None:
    used = [step.get("signature") for step in steps if step.get("type") == "thought"]
    if not used:
        return None
    for signature in used:
        invalidate_thought_signature(signature)
    rotated = [
        {**step, "signature": next_thought_signature()} if step.get("type") == "thought" else step
        for step in steps
    ]
    fresh = [step.get("signature") for step in rotated if step.get("type") == "thought"]
    return rotated if any(value != old for value, old in zip(fresh, used)) else None


def fake_tool_call_result(name: str, args: dict, result: object) -> list[dict]:
    call_id = str(uuid.uuid4())
    return [
        {"type": "thought", "signature": next_thought_signature()},
        {"type": "function_call", "id": call_id, "name": name, "arguments": args},
        {"type": "function_result", "name": name, "call_id": call_id,
         "result": [{"type": "text", "text": json.dumps(result, ensure_ascii=False)}]},
    ]


def flush_thought_signatures() -> None:
    global _dirty
    if not _dirty:
        return
    path: Path = config.thought_state_file
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_suffix(path.suffix + ".tmp")
        temporary.write_text(json.dumps({"signatures": _pool[-MAX_POOL_SIZE:]}, indent=2) + "\n", encoding="utf-8")
        try:
            temporary.chmod(0o600)
        except OSError:
            pass
        temporary.replace(path)
        try:
            path.chmod(0o600)
        except OSError:
            pass
        _dirty = False
    except OSError:
        log.exception("Could not persist Gemini thought signatures; will retry at shutdown")


async def close_thought_signatures() -> None:
    if _flush_task and not _flush_task.done():
        _flush_task.cancel()
        await asyncio.gather(_flush_task, return_exceptions=True)
    flush_thought_signatures()
