"""Gemini-chan: the assistant in the room, not one of the cast.

She answers questions about the code, the docs and the conversation itself. The
work is split in two because the model she thinks with cannot call tools while it
speaks: a tool-capable model looks things up and returns evidence, and the
extended-thinking model answers from that evidence in her own voice.

Both halves spend from her own ledger, so her thinking never takes a turn away
from the characters.
"""
from __future__ import annotations

import json
import logging
import re
from pathlib import Path

from . import gemini
from .characters import CHAR_DIR, load_characters
from .config import ROOT, config
from .store import store
from .token_budget import assistant_token_budget

log = logging.getLogger("aira.assistant")

MAX_TOOL_ROUNDS = 3
MAX_TOOL_RESULT_CHARS = 3000
READ_LIMIT_CHARS = 8000
SEARCH_RESULT_LIMIT = 20
SEARCH_FILE_LIMIT = 300
# Secrets and runtime state are readable by the process, never by her.
BLOCKED_PARTS = {".aira", ".git", ".venv", "__pycache__", "node_modules"}
READABLE_SUFFIXES = {".py", ".md", ".json", ".txt", ".toml", ".yml", ".yaml", ".sh", ".html"}

TOOL_INSTRUCTIONS = (
    "คุณคือผู้ช่วยของห้องแชทนี้ หน้าที่คือตอบคำถามให้ตรงกับข้อมูลจริงที่สุด\n"
    "ถ้าคำตอบต้องใช้ข้อมูลที่ยังไม่มีในบทสนทนา ให้ขอ tool ก่อน โดยตอบเป็นบรรทัดเดียวเท่านั้น:\n"
    'TOOL ชื่อ tool {"arg": "ค่า"}\n'
    "เรียกได้ครั้งละ 1 tool ต่อหนึ่งคำตอบ แล้วรอผลลัพธ์\n"
    "ถ้ามีข้อมูลพอแล้ว ให้ตอบเป็นคำตอบสุดท้ายตามปกติ (ห้ามมีคำว่า TOOL ในคำตอบสุดท้าย)\n"
    "ห้ามเดา ห้ามแต่งข้อมูล ถ้าหาไม่พบให้บอกว่าไม่พบ ตอบภาษาไทย กระชับ ตรงประเด็น"
)

TOOL_LINES = (
    "ใช้ได้เฉพาะ tool ต่อไปนี้:\n"
    "- recent_messages {\"limit\": จำนวน} — อ่านข้อความล่าสุดของห้อง รวมของตัวละคร\n"
    "- read_file {\"path\": \"พาธจากรากโปรเจกต์\"} — อ่านไฟล์โค้ดหรือเอกสาร\n"
    "- search_text {\"text\": \"ข้อความ\"} — ค้นข้อความในโค้ดและเอกสาร"
)

def _safe_path(raw: str) -> Path | None:
    candidate = (ROOT / str(raw or "").strip().lstrip("/")).resolve()
    if candidate != ROOT and ROOT not in candidate.parents:
        return None
    if BLOCKED_PARTS & set(candidate.relative_to(ROOT).parts):
        return None
    return candidate


def _recent_messages(limit: int, session_key: str) -> dict:
    count = max(1, min(50, int(limit or 10)))
    names = {item.id: item.name for item in load_characters()}
    lines = []
    for row in store.get_history(count, session_key):
        speaker = (names.get(row.get("character_id")) or row.get("user_name") or "ใครสักคน"
                   if row.get("role") == "model" else row.get("user_name") or "ผู้ใช้")
        lines.append(f"{speaker}: {row.get('text') or ''}")
    return {"messages": lines}


def _read_file(path: str) -> dict:
    target = _safe_path(path)
    if target is None:
        return {"error": "อ่านไฟล์นี้ไม่ได้"}
    if not target.is_file() or target.suffix.lower() not in READABLE_SUFFIXES:
        return {"error": "ไม่พบไฟล์ที่อ่านได้ในพาธนี้"}
    text = target.read_text("utf-8", errors="replace")
    return {"path": str(target.relative_to(ROOT)),
            "content": text[:READ_LIMIT_CHARS],
            "truncated": len(text) > READ_LIMIT_CHARS}


def _search_text(text: str) -> dict:
    needle = str(text or "").strip()
    if len(needle) < 2:
        return {"error": "ข้อความค้นหาสั้นเกินไป"}
    matches = []
    scanned = 0
    for path in sorted(ROOT.rglob("*")):
        if scanned >= SEARCH_FILE_LIMIT or len(matches) >= SEARCH_RESULT_LIMIT:
            break
        if not path.is_file() or path.suffix.lower() not in READABLE_SUFFIXES:
            continue
        relative = path.relative_to(ROOT)
        if BLOCKED_PARTS & set(relative.parts):
            continue
        scanned += 1
        try:
            lines = path.read_text("utf-8", errors="replace").splitlines()
        except OSError:
            continue
        for number, line in enumerate(lines, start=1):
            if needle.casefold() in line.casefold():
                matches.append(f"{relative}:{number}: {line.strip()[:160]}")
                if len(matches) >= SEARCH_RESULT_LIMIT:
                    break
    return {"matches": matches or ["ไม่พบข้อความนี้"]}


def run_tool(name: str, arguments: dict, session_key: str) -> dict:
    if name == "recent_messages":
        return _recent_messages(arguments.get("limit", 10), session_key)
    if name == "read_file":
        return _read_file(arguments.get("path", ""))
    if name == "search_text":
        return _search_text(arguments.get("text", ""))
    return {"error": f"ไม่รู้จัก tool {name}"}


TOOL_CALL = re.compile(r"^\s*TOOL\s+([a-z_]+)\s*(\{.*\})\s*$", re.MULTILINE)
MAX_LIVE_ROUNDS = 3


def _parse_tool_call(text: str) -> tuple[str, dict] | None:
    """Read the one tool she asked for, if she asked for one."""
    match = TOOL_CALL.search(text or "")
    if not match:
        return None
    try:
        arguments = json.loads(match.group(2))
    except ValueError:
        return None
    return match.group(1), arguments if isinstance(arguments, dict) else {}


async def _live_turn(question: str, results: list[str]) -> str:
    """One turn of her own model, given whatever the tools returned so far."""
    system_instruction = "\n\n".join(filter(None, [
        _persona(), TOOL_INSTRUCTIONS, TOOL_LINES,
        ("ผลลัพธ์จาก tool ที่คุณขอไปแล้ว:\n" + "\n".join(results)) if results else "",
    ]))
    return await gemini.generate_live_text(
        "gemini1", [{"type": "text", "text": question}], system_instruction,
        model=config.assistant_model, budget=assistant_token_budget,
        thinking_level="HIGH", max_output_tokens=2048,
    )


async def respond(question: str, session_key: str) -> str:
    """She looks things up and answers, all on her own model.

    The model she thinks with cannot call functions itself, so it asks for a tool in
    one short line and the answer is fed back to it. No other model takes part.
    """
    results: list[str] = []
    for round_index in range(MAX_LIVE_ROUNDS):
        raw = await _live_turn(question, results)
        call = _parse_tool_call(raw)
        if call is None:
            log.info("Assistant reply: question_chars=%s tool_rounds=%s reply_chars=%s",
                     len(question), len(results), len(raw))
            return " ".join((raw or "").split())
        name, arguments = call
        result = run_tool(name, arguments, session_key)
        summary = str(result)[:MAX_TOOL_RESULT_CHARS]
        log.info("Assistant tool call: round=%s tool=%s args=%s chars=%s",
                 round_index + 1, name, arguments, len(summary))
        results.append(f"[{name} {arguments}] {summary}")
    log.info("Assistant used all %s tool rounds and answers with what it has", MAX_LIVE_ROUNDS)
    return " ".join((await _live_turn(question, results)).split())


def _persona() -> str:
    path = CHAR_DIR / "prompts" / "gemini-chan.md"
    try:
        return path.read_text("utf-8").strip()
    except OSError as exc:
        raise RuntimeError(f"Cannot read the assistant prompt at {path}: {exc}") from exc
