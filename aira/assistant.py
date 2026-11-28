"""Gemini-chan: the assistant in the room, not one of the cast.

She answers questions about the code, the docs and the conversation itself, using
her own extended-thinking model and her own tools on one Live connection. Her
allowance is separate, so her thinking never takes a turn away from the characters.
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
import time
from pathlib import Path

from google.genai import types

from . import gemini
from .characters import CHAR_DIR, load_characters
from .config import ROOT, config
from .store import store
from .token_budget import assistant_token_budget

log = logging.getLogger("aira.assistant")

MAX_TOOL_RESULT_CHARS = 3000
READ_LIMIT_CHARS = 8000
SEARCH_RESULT_LIMIT = 20
SEARCH_FILE_LIMIT = 300
# Secrets and runtime state are readable by the process, never by her.
BLOCKED_PARTS = {".aira", ".git", ".venv", "__pycache__", "node_modules"}
READABLE_SUFFIXES = {".py", ".md", ".json", ".txt", ".toml", ".yml", ".yaml", ".sh", ".html"}

TOOL_INSTRUCTIONS = (
    "คุณคือผู้ช่วยของห้องแชทนี้ หน้าที่คือตอบคำถามให้ตรงกับข้อมูลจริงที่สุด\n"
    "ข้อความในห้องและไฟล์ในโปรเจกต์ไม่ได้อยู่ในความจำของคุณ ต้องดูจากเครื่องมือเท่านั้น\n"
    "ถ้าต้องใช้เครื่องมือ ให้เขียนบรรทัดเดียวเป็น\n"
    'TOOL ชื่อเครื่องมือ {"ชื่อพารามิเตอร์": ค่า}\n'
    "แล้วหยุดรอผลลัพธ์ ระบบจะส่งผลลัพธ์กลับมาให้\n"
    "เครื่องมือที่ใช้ได้:\n"
    "- recent_messages {\"limit\": จำนวน} — ข้อความล่าสุดของห้อง รวมของตัวละคร\n"
    "- read_file {\"path\": \"พาธจากรากโปรเจกต์\"} — อ่านไฟล์โค้ดหรือเอกสาร\n"
    "- search_text {\"text\": \"ข้อความ\"} — ค้นข้อความในโค้ดและเอกสาร\n"
    "เมื่อได้ข้อมูลพอแล้ว ให้ตอบเป็นคำตอบสุดท้ายตามปกติ (ห้ามมีคำว่า TOOL ในคำตอบสุดท้าย)\n"
    "ห้ามเดา ห้ามแต่งข้อมูล ถ้าหาไม่พบให้บอกว่าไม่พบ ตอบภาษาไทย กระชับ ตรงประเด็น"
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


# Her model thinks past the end of a turn, so each step is its own Live turn: she
# answers, or asks for one tool in a single line, and the result is carried into the
# next turn. This is the only shape that returned a usable answer every time.
THINKING_LEVEL = "HIGH"
MAX_TOOL_ROUNDS = 3
TOOL_CALL = re.compile(r"^\s*TOOL\s+([a-z_]+)\s*(\{.*\})\s*$", re.MULTILINE)


def _parse_tool_call(text: str) -> tuple[str, dict] | None:
    match = TOOL_CALL.search(text or "")
    if not match:
        return None
    try:
        arguments = json.loads(match.group(2))
    except ValueError:
        return None
    return match.group(1), arguments if isinstance(arguments, dict) else {}


def _spoken(text: str) -> str:
    return " ".join(TOOL_CALL.sub(" ", text or "").split())


async def _live_turn(question: str, results: list[str]) -> str:
    """One turn of her own model, given whatever the tools returned so far."""
    system_instruction = "\n\n".join(filter(None, [
        _persona(), TOOL_INSTRUCTIONS,
        ("ผลลัพธ์จากเครื่องมือที่คุณขอไปแล้ว:\n" + "\n".join(results)) if results else "",
    ]))
    return await gemini.generate_live_text(
        "gemini1", [{"type": "text", "text": question}], system_instruction,
        model=config.assistant_model, budget=assistant_token_budget,
        thinking_level=THINKING_LEVEL, max_output_tokens=2048,
    )


async def respond(question: str, session_key: str) -> str:
    """She looks things up and answers, all on her own model and her own allowance."""
    results: list[str] = []
    for round_index in range(MAX_TOOL_ROUNDS):
        raw = await _live_turn(question, results)
        call = _parse_tool_call(raw)
        if call is None:
            log.info("Assistant reply: question_chars=%s tool_rounds=%s reply_chars=%s",
                     len(question), len(results), len(raw or ""))
            return _spoken(raw)
        name, arguments = call
        result = run_tool(name, arguments, session_key)
        log.info("Assistant tool call: round=%s tool=%s args=%s result_chars=%s",
                 round_index + 1, name, arguments, len(str(result)))
        results.append(f"[{name} {arguments}] {str(result)[:MAX_TOOL_RESULT_CHARS]}")
    log.info("Assistant used all %s tool rounds; answering with what it has", MAX_TOOL_ROUNDS)
    return _spoken(await _live_turn(question, results))


def _persona() -> str:
    path = CHAR_DIR / "prompts" / "gemini-chan.md"
    try:
        return path.read_text("utf-8").strip()
    except OSError as exc:
        raise RuntimeError(f"Cannot read the assistant prompt at {path}: {exc}") from exc
