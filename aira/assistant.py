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
from .token_budget import assistant_token_budget, estimate_tokens, usage_tpm_tokens

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


# The answer is spoken on one Live session. At HIGH the model finishes thinking
# after the turn has already closed and only a preamble comes out, so she runs at
# MEDIUM. She asks for a tool in one short line and the socket stays open while the
# result goes back, which is the only route that worked reliably on her model.
THINKING_LEVEL = "HIGH"
MAX_TOOL_ROUNDS = 3
# She keeps talking after the turn closes, so the turn is over when the socket goes
# quiet rather than when the server says the turn is complete.
QUIET_SECONDS = 12.0
TURN_TIMEOUT_SECONDS = 90.0
TOOL_CALL = re.compile(r"^\s*TOOL\s+([a-z_]+)\s*(\{.*\})\s*$", re.MULTILINE)


def _live_config() -> types.LiveConnectConfig:
    return types.LiveConnectConfig(
        response_modalities=[types.Modality.AUDIO],
        output_audio_transcription=types.AudioTranscriptionConfig(),
        thinking_config=types.ThinkingConfig(thinking_level=THINKING_LEVEL),
        system_instruction="\n\n".join([_persona(), TOOL_INSTRUCTIONS]),
    )


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


async def _read_turn(stream, deadline: float, spent: list[int]) -> str:
    """Everything she says in this turn, read from the one open stream."""
    chunks: list[str] = []
    while time.monotonic() < deadline:
        try:
            message = await asyncio.wait_for(stream.__anext__(), timeout=QUIET_SECONDS)
        except (asyncio.TimeoutError, StopAsyncIteration):
            # Nothing more is coming: she has finished this turn.
            break
        usage = getattr(message, "usage_metadata", None)
        if usage is not None:
            spent.append(usage_tpm_tokens(usage) or 0)
        content = getattr(message, "server_content", None)
        if content and content.output_transcription:
            chunk = content.output_transcription.text or ""
            if chunk.strip():
                chunks.append(chunk)
        if getattr(message, "go_away", None):
            log.warning("Assistant session received go_away; stopping")
            break
    return " ".join(chunks)


async def respond(question: str, session_key: str) -> str:
    """She answers, and asks for whatever she needs to look up, on her own model."""
    client = gemini.live_client("gemini1")
    estimate = estimate_tokens(question) + 2000
    reservation = await assistant_token_budget.reserve(estimate, label="assistant_live")
    spent: list[int] = []
    rounds = 0
    try:
        async with client.aio.live.connect(model=config.assistant_model,
                                           config=_live_config()) as session:
            await session.send_client_content(
                turns=types.Content(role="user", parts=[types.Part.from_text(text=question)]),
                turn_complete=True,
            )
            stream = session.receive()
            while rounds <= MAX_TOOL_ROUNDS:
                said = await _read_turn(stream, time.monotonic() + TURN_TIMEOUT_SECONDS, spent)
                call = _parse_tool_call(said)
                if call is None:
                    log.info("Assistant reply: question_chars=%s tool_rounds=%s reply_chars=%s",
                             len(question), rounds, len(said))
                    return _spoken(said)
                if rounds == MAX_TOOL_ROUNDS:
                    break
                name, arguments = call
                result = run_tool(name, arguments, session_key)
                rounds += 1
                log.info("Assistant tool call: round=%s tool=%s args=%s result_chars=%s",
                         rounds, name, arguments, len(str(result)))
                await session.send_client_content(
                    turns=types.Content(role="user", parts=[types.Part.from_text(
                        text=("ผลลัพธ์ของ " + name + ": " + str(result)[:MAX_TOOL_RESULT_CHARS]
                              + "\nถ้ามีข้อมูลพอแล้วตอบเป็นคำตอบสุดท้าย ถ้ายังขาดให้ขอเครื่องมืออื่นต่อ"))]),
                    turn_complete=True,
                )
            # She used every round looking things up: ask for the answer using what
            # has already been gathered instead of returning the request line.
            await session.send_client_content(
                turns=types.Content(role="user", parts=[types.Part.from_text(
                    text="ตอบเป็นคำตอบสุดท้ายจากข้อมูลที่มีอยู่ตอนนี้ ห้ามขอเครื่องมืออีก")]),
                turn_complete=True,
            )
            said = await _read_turn(stream, time.monotonic() + TURN_TIMEOUT_SECONDS, spent)
            log.info("Assistant reply after all tool rounds: rounds=%s reply_chars=%s",
                     rounds, len(said))
            return _spoken(said)
    finally:
        await assistant_token_budget.settle(reservation, sum(spent) or estimate)


def _persona() -> str:
    path = CHAR_DIR / "prompts" / "gemini-chan.md"
    try:
        return path.read_text("utf-8").strip()
    except OSError as exc:
        raise RuntimeError(f"Cannot read the assistant prompt at {path}: {exc}") from exc
