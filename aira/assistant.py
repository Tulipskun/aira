"""Gemini-chan: the assistant in the room, not one of the cast.

She answers questions about the code, the docs and the conversation itself. The
work is split in two because the model she thinks with cannot call tools while it
speaks: a tool-capable model looks things up and returns evidence, and the
extended-thinking model answers from that evidence in her own voice.

Both halves spend from her own ledger, so her thinking never takes a turn away
from the characters.
"""
from __future__ import annotations

import logging
from pathlib import Path

from google import genai
from google.genai import types

from . import gemini
from .characters import CHAR_DIR, load_characters
from .config import ROOT, config
from .store import store
from .token_budget import (
    assistant_token_budget, estimate_tokens, usage_tpm_tokens,
)

log = logging.getLogger("aira.assistant")

MAX_TOOL_ROUNDS = 3
MAX_EVIDENCE_CHARS = 6000
MAX_TOOL_RESULT_CHARS = 3000
READ_LIMIT_CHARS = 8000
SEARCH_RESULT_LIMIT = 20
SEARCH_FILE_LIMIT = 300
# Secrets and runtime state are readable by the process, never by her.
BLOCKED_PARTS = {".aira", ".git", ".venv", "__pycache__", "node_modules"}
READABLE_SUFFIXES = {".py", ".md", ".json", ".txt", ".toml", ".yml", ".yaml", ".sh", ".html"}

TOOL_INSTRUCTIONS = (
    "คุณคือผู้ช่วยของห้องแชทนี้ หน้าที่คือตอบคำถามให้ตรง 사실ที่สุด\n"
    "ถ้าคำตอบต้องใช้ข้อมูลที่ไม่ได้อยู่ในข้อความของผู้ใช้ ให้เรียก tool ก่อนตอบเสมอ\n"
    "ห้ามเดา ห้ามแต่งข้อมูล ถ้าหาไม่พบให้บอกว่าไม่พบ\n"
    "ตอบเป็นภาษาไทย กระชับ ตรงประเด็น ไม่ต้องใส่ Markdown หนัก ๆ"
)

DECLARATIONS = [
    types.FunctionDeclaration(
        name="recent_messages",
        description="อ่านข้อความล่าสุดของห้อง รวมข้อความของตัวละครในห้องด้วย",
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


def _tool_client() -> genai.Client:
    return gemini.api_client("gemini1")


async def gather(question: str, session_key: str) -> str:
    """Let the tool model look things up and return what it found."""
    client = _tool_client()
    contents = [types.Content(role="user", parts=[types.Part.from_text(text=question)])]
    evidence = []
    for round_index in range(MAX_TOOL_ROUNDS):
        estimate = estimate_tokens(question) + sum(estimate_tokens(item) for item in evidence)
        reservation = await assistant_token_budget.reserve(estimate, label="assistant_tools")
        try:
            response = await client.aio.models.generate_content(
                model=config.assistant_tool_model, contents=contents,
                config=types.GenerateContentConfig(
                    system_instruction=TOOL_INSTRUCTIONS,
                    tools=[types.Tool(function_declarations=DECLARATIONS)],
                ),
            )
        except Exception:
            await assistant_token_budget.settle(reservation, 0)
            raise
        await assistant_token_budget.settle(
            reservation, usage_tpm_tokens(getattr(response, "usage_metadata", None)))
        parts = list(getattr(response.candidates[0].content, "parts", None) or [])
        calls = [part.function_call for part in parts if getattr(part, "function_call", None)]
        if not calls:
            text = (getattr(response, "text", "") or "").strip()
            if text and not evidence:
                evidence.append(text)
            break
        contents.append(response.candidates[0].content)
        responses = []
        for call in calls:
            arguments = dict(getattr(call, "args", None) or {})
            result = run_tool(str(call.name), arguments, session_key)
            summary = str(result)[:MAX_TOOL_RESULT_CHARS]
            evidence.append(f"[{call.name} {arguments}] {summary}")
            log.info("Assistant tool call: round=%s tool=%s args=%s chars=%s",
                     round_index + 1, call.name, arguments, len(summary))
            responses.append(types.Part.from_function_response(name=str(call.name), response=result))
        contents.append(types.Content(role="user", parts=responses))
    joined = "\n".join(evidence).strip()
    return joined[:MAX_EVIDENCE_CHARS]


def _persona() -> str:
    path = CHAR_DIR / "prompts" / "gemini-chan.md"
    try:
        return path.read_text("utf-8").strip()
    except OSError as exc:
        raise RuntimeError(f"Cannot read the assistant prompt at {path}: {exc}") from exc


async def answer(question: str, evidence: str) -> str:
    """The extended-thinking model replies in her own voice, from the evidence."""
    system_instruction = "\n\n".join(filter(None, [
        _persona(),
        TOOL_INSTRUCTIONS,
        "ข้อมูลที่ tool ดึงมาให้แล้ว (ใช้ตอบได้เลย ไม่ต้องเรียก tool เอง):\n"
        + (evidence or "(ไม่มีข้อมูลเพิ่มเติม)"),
    ]))
    return await gemini.generate_live_text(
        "gemini1", [{"type": "text", "text": question}], system_instruction,
        model=config.assistant_model, budget=assistant_token_budget,
        thinking_level="HIGH", max_output_tokens=2048,
    )


async def respond(question: str, session_key: str) -> str:
    """Look the question up, then answer it."""
    evidence = await gather(question, session_key)
    reply = await answer(question, evidence)
    log.info("Assistant reply: question_chars=%s evidence_chars=%s reply_chars=%s",
             len(question), len(evidence), len(reply))
    return " ".join(reply.split())
