"""Gemini-chan: the assistant in the room, not one of the cast.

She answers questions about the code, the docs and the conversation itself. She
runs on the tool-capable Live model, so she looks things up herself on one open
connection and answers from what she found. Her allowance is separate, so her
turns never take a turn away from the characters.
"""
from __future__ import annotations

import asyncio
import logging
import time
from pathlib import Path

from google.genai import types

from . import gemini
from .characters import CHAR_DIR, load_characters
from .config import ROOT, config
from .store import store
from .token_budget import assistant_token_budget, estimate_tokens, usage_tpm_tokens

log = logging.getLogger("aira.assistant")

# A tool call arrives a few seconds after the turn completes, so the socket is read
# until it goes quiet instead of closing when the first turn ends.
QUIET_SECONDS = 15.0
SESSION_TIMEOUT_SECONDS = 150.0
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
    "เมื่อถูกถามถึงสิ่งที่คนในห้องพูด หรือสิ่งที่อยู่ในโค้ด/เอกสาร ให้เรียกเครื่องมือก่อนตอบ\n"
    "ห้ามเดา ห้ามแต่งข้อมูล ถ้าหาไม่พบให้บอกว่าไม่พบ ตอบภาษาไทย กระชับ ตรงประเด็น"
)

DECLARATIONS = [
    types.FunctionDeclaration(
        name="recent_messages",
        description="อ่านข้อความล่าสุดของห้องแชทนี้ รวมข้อความของตัวละครในห้อง",
        parameters={"type": "object",
                    "properties": {"limit": {"type": "integer",
                                             "description": "จำนวนข้อความล่าสุด (1-50)"}},
                    "required": ["limit"]}),
    types.FunctionDeclaration(
        name="read_file",
        description="อ่านไฟล์ในโปรเจกต์ เช่น เอกสารหรือโค้ด",
        parameters={"type": "object",
                    "properties": {"path": {"type": "string",
                                            "description": "พาธเทียบจากรากโปรเจกต์"}},
                    "required": ["path"]}),
    types.FunctionDeclaration(
        name="search_text",
        description="ค้นข้อความในไฟล์โค้ดและเอกสารของโปรเจกต์",
        parameters={"type": "object",
                    "properties": {"text": {"type": "string", "description": "ข้อความที่ต้องการหา"}},
                    "required": ["text"]}),
]


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


def _persona() -> str:
    path = CHAR_DIR / "prompts" / "gemini-chan.md"
    try:
        return path.read_text("utf-8").strip()
    except OSError as exc:
        raise RuntimeError(f"Cannot read the assistant prompt at {path}: {exc}") from exc


def _live_config() -> types.LiveConnectConfig:
    return types.LiveConnectConfig(
        response_modalities=[types.Modality.AUDIO],
        output_audio_transcription=types.AudioTranscriptionConfig(),
        input_audio_transcription=types.AudioTranscriptionConfig(),
        system_instruction="\n\n".join([_persona(), TOOL_INSTRUCTIONS]),
        tools=[types.Tool(function_declarations=DECLARATIONS)],
    )


def _tool_responses(call, session_key: str) -> list[types.FunctionResponse]:
    responses = []
    for item in call.function_calls:
        arguments = dict(getattr(item, "args", None) or {})
        result = run_tool(str(item.name), arguments, session_key)
        log.info("Assistant tool call: tool=%s args=%s result_chars=%s",
                 item.name, arguments, len(str(result)))
        responses.append(types.FunctionResponse(id=item.id, name=str(item.name), response=result))
    return responses


async def respond(question: str, session_key: str) -> str:
    """One open Live session: she reads what she needs, then answers."""
    client = gemini.live_client("gemini1")
    estimate = estimate_tokens(question) + 2000
    reservation = await assistant_token_budget.reserve(estimate, label="assistant_live")
    spent: list[int] = []
    text: list[str] = []
    calls = 0
    try:
        async with client.aio.live.connect(model=config.assistant_model,
                                           config=_live_config()) as session:
            await session.send_client_content(
                turns=types.Content(role="user", parts=[types.Part.from_text(text=question)]),
                turn_complete=True,
            )
            deadline = time.monotonic() + SESSION_TIMEOUT_SECONDS
            while time.monotonic() < deadline:
                try:
                    message = await asyncio.wait_for(
                        session.receive().__anext__(), timeout=QUIET_SECONDS)
                except (asyncio.TimeoutError, StopAsyncIteration):
                    # Nothing more is coming on this connection: she is done.
                    break
                usage = getattr(message, "usage_metadata", None)
                if usage is not None:
                    spent.append(usage_tpm_tokens(usage) or 0)
                call = getattr(message, "tool_call", None)
                if call:
                    calls += 1
                    # What she said before looking things up is not the answer.
                    text.clear()
                    await session.send_tool_response(
                        function_responses=_tool_responses(call, session_key))
                    continue
                content = getattr(message, "server_content", None)
                if content and content.output_transcription:
                    chunk = content.output_transcription.text or ""
                    if chunk.strip():
                        text.append(chunk)
                if getattr(message, "go_away", None):
                    log.warning("Assistant session received go_away; stopping")
                    break
    finally:
        await assistant_token_budget.settle(reservation, sum(spent) or estimate)
    reply = " ".join(" ".join(text).split())
    log.info("Assistant reply: question_chars=%s tool_calls=%s reply_chars=%s input_tokens=%s",
             len(question), calls, len(reply), sum(spent) or estimate)
    return reply
