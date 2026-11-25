from __future__ import annotations

import asyncio
import json
import logging
import random
import re
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

from google import genai
from google.genai import types

from .config import config, ROOT
from .store import utc_now
from .token_budget import (
    estimate_live_request_tokens, live_token_budget, usage_metrics, usage_tpm_tokens,
)
from .debug_dump import debug_dump

log = logging.getLogger("aira.gemini")
_clients: dict[str, genai.Client] = {}
_live_clients: dict[str, genai.Client] = {}
_model_input_limits: dict[str, int] = {}
_key_state = {"gemini1": 0, "gemini2": 0, "embedding2": 0}
try:
    _key_state.update(json.loads(config.key_state_file.read_text("utf-8")))
except (OSError, ValueError, TypeError):
    pass

def _save_key_state() -> None:
    config.key_state_file.parent.mkdir(parents=True, exist_ok=True)
    tmp = config.key_state_file.with_suffix(".tmp")
    tmp.write_text(json.dumps(_key_state, indent=2) + "\n", encoding="utf-8")
    tmp.replace(config.key_state_file)


def _status(error: BaseException) -> int | None:
    for key in ("status_code", "status", "code"):
        value = getattr(error, key, None)
        if isinstance(value, int):
            return value
    response = getattr(error, "response", None)
    return getattr(response, "status_code", None)


def _keys(stage: str) -> list[str]:
    if stage == "gemini1":
        return config.gemini1_keys or config.gemini_keys
    if stage == "gemini2":
        return config.gemini2_keys or config.gemini_keys
    if stage == "embedding2":
        return config.embedding_keys or config.gemini_keys
    raise ValueError(f"Unknown Gemini stage: {stage}")


def _key(stage: str) -> str:
    keys = _keys(stage)
    if not keys:
        raise RuntimeError("Gemini API key is missing; configure it in the /aira admin panel")
    index = int(_key_state.get(stage, 0)) % len(keys)
    return keys[index]


def _rotate(stage: str) -> None:
    _key_state[stage] = int(_key_state.get(stage, 0)) + 1
    _save_key_state()


def _client(stage: str) -> genai.Client:
    key = _key(stage)
    if key not in _clients:
        _clients[key] = genai.Client(api_key=key)
    return _clients[key]


def _live_client(stage: str) -> genai.Client:
    """Gemini Live 3.8 is served on the v1beta Gemini API endpoint."""
    key = _key(stage)
    if key not in _live_clients:
        _live_clients[key] = genai.Client(
            api_key=key,
            http_options=types.HttpOptions(api_version="v1beta"),
        )
    return _live_clients[key]


async def _model_input_limit(client: genai.Client, model: str) -> int:
    """Read the model's real input-token limit once and cache it per process."""
    cached = _model_input_limits.get(model)
    if cached:
        return cached
    try:
        info = await client.aio.models.get(model=model)
        limit = int(getattr(info, "input_token_limit", 0) or 0)
        if limit > 0:
            _model_input_limits[model] = limit
            log.info("Gemini model context limit: model=%s input=%s output=%s",
                     model, limit, getattr(info, "output_token_limit", None))
            return limit
    except Exception as exc:
        log.warning("Could not read Gemini model input-token limit: model=%s error=%s",
                    model, type(exc).__name__)
    # Safe fallback if model metadata is temporarily unavailable.
    import os
    fallback = max(4096, int(os.environ.get("AIRA_CONTEXT_INPUT_LIMIT", "32768")))
    _model_input_limits[model] = fallback
    log.warning("Using fallback context limit: model=%s input=%s", model, fallback)
    return fallback


def thai_timestamp(timestamp: str | None) -> str:
    if not timestamp:
        return ""
    try:
        value = datetime.fromisoformat(timestamp.replace("Z", "+00:00"))
        if value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        local = value.astimezone(ZoneInfo(config.timezone))
        return local.isoformat(timespec="seconds")
    except (ValueError, TypeError):
        return timestamp


def current_time_block() -> str:
    return f"<current_time>{thai_timestamp(utc_now())}</current_time>"


def _read_prompt(path: Path, label: str) -> str:
    try:
        content = path.read_text("utf-8")
        content = re.sub(r"<!--[\s\S]*?-->", "", content)
        return content.strip()
    except OSError as exc:
        raise RuntimeError(f"Cannot read {label} prompt at {path}: {exc}") from exc


def _partner(name: str) -> str:
    clean = " ".join((name or "เพื่อน").split())[:40].strip()
    return clean or "เพื่อน"


NO_PAD_BEFORE = set(" *_([{<") | {chr(34), chr(39), "“", "‘", "»"}
NO_PAD_AFTER = set(" *_)]{}>.,:;!?/") | {chr(34), chr(39), "’", "”", "«"}
THAI_SCRIPT = re.compile(r"[\u0E00-\u0E7F]")


def fill_partner(text: str, name: str | None) -> str:
    who = _partner(name or "")
    pieces = text.split("{{partner}}")
    if len(pieces) == 1:
        return text
    result = pieces[0]
    for tail in pieces[1:]:
        after = tail[0] if tail else ""
        before = result[-1] if result else ""
        if before and before not in NO_PAD_BEFORE and who[0] not in NO_PAD_AFTER:
            if not (THAI_SCRIPT.search(before) and THAI_SCRIPT.search(who[0])):
                result += " "
        result += who
        if after and who[-1] not in NO_PAD_BEFORE and after not in NO_PAD_AFTER:
            if not (THAI_SCRIPT.search(who[-1]) and THAI_SCRIPT.search(after)):
                result += " "
        result += tail
    return result


def _extract_object(raw: str) -> dict | None:
    raw = (raw or "").strip()
    fenced = re.search(r"```(?:json)?\s*([\s\S]*?)```", raw, re.I)
    sources = [fenced.group(1)] if fenced else []
    sources.append(raw)
    decoder = json.JSONDecoder()
    for source in sources:
        start = source.find("{")
        while start >= 0:
            try:
                value, _ = decoder.raw_decode(source[start:])
                if isinstance(value, dict):
                    return value
            except ValueError:
                pass
            start = source.find("{", start + 1)
    return None


def _pick(obj: dict, *keys: str):
    for key in keys:
        if key in obj and obj[key] is not None:
            return obj[key]
    return None


def _to_bool(value) -> bool | None:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value != 0
    if isinstance(value, str):
        value = value.strip().casefold()
        if value in {"true", "yes", "ya", "1", "ตกลง", "ใช่", "ครับ", "ค่ะ"}: return True
        if value in {"false", "no", "0", "ไม่ใช่", "ไม่", "ปฏิเสธ", "ปฎิเสธ"}: return False
    return None


def _character_image_dir(character_id: str | None) -> Path:
    # Every character uses the same directory convention: images/<character_id>/.
    return config.images_dir / (character_id or "isla")


def _image_names(character_id: str | None = None) -> list[str]:
    extensions = {".jpg", ".jpeg", ".png", ".webp", ".gif"}
    directory = _character_image_dir(character_id)
    if not directory.is_dir():
        return []
    return sorted(
        path.name for path in directory.iterdir()
        if path.is_file() and path.suffix.lower() in extensions
    )


def _normalize_image(value: str | None, character_id: str | None = None) -> str:
    if not value or value.strip().lower() in {"none", "no_image", "null"}:
        return ""
    value = Path(value.strip()).name
    return value if value in _image_names(character_id) else ""


def parse_reply(raw: str) -> dict:
    parsed = _extract_object(raw)
    if not parsed:
        return {"text": (raw or "").strip(), "summary": "", "mood": "", "color": None, "rps": None, "parsed": False}
    text = _pick(parsed, "Isla", "isla", "reply", "message", "text", "response")
    summary = _pick(parsed, "summery", "summary", "recap", "note", "memory")
    mood = _pick(parsed, "mood", "emotion", "feeling", "อารมณ์")
    color = _pick(parsed, "color")
    rps = _pick(parsed, "rps", "RPS")
    raw_relationships = _pick(parsed, "character_relationships", "relationships") or []
    relationships = []
    if isinstance(raw_relationships, list):
        for item in raw_relationships[:4]:
            if not isinstance(item, dict):
                continue
            target = str(item.get("target_character_id") or item.get("targetCharacterId") or "").strip()
            relationship = str(item.get("relationship") or "").strip()
            if target and relationship:
                relationships.append({"target_character_id": target, "relationship": relationship})
    return {
        "text": str(text or "").strip(),
        "summary": str(summary or "").strip(),
        "mood": str(mood or "").strip()[:60],
        "color": normalize_color(color),
        "rps": rps if rps in {"rock", "paper", "scissors"} else None,
        "relationships": relationships,
        "next_speaker_id": str(_pick(parsed, "next_speaker_id", "nextSpeakerId") or "").strip(),
        "parsed": True,
    }


NAMED_COLORS = {
    "red": "ED4245", "blue": "3498DB", "green": "57F287", "yellow": "FEE75C",
    "pink": "E91E63", "purple": "9B59B6", "orange": "E67E22", "white": "FFFFFF",
    "black": "000000", "grey": "95A5A6", "gray": "95A5A6", "cyan": "1ABC9C",
    "teal": "11806A", "gold": "F1C40F", "navy": "34495E",
    "แดง": "ED4245", "ชมพู": "E91E63", "ม่วง": "9B59B6", "ฟ้า": "3498DB",
    "น้ำเงิน": "34495E", "เขียว": "1F8B4C", "เหลือง": "F1C40F", "ส้ม": "E67E22",
    "ขาว": "FFFFFF", "ดำ": "2C2F33", "เทา": "95A5A6", "คราม": "206694",
}


def normalize_color(value) -> int | None:
    if isinstance(value, int) and 0 <= value <= 0xFFFFFF:
        return value
    if not isinstance(value, str):
        return None
    raw = value.strip().lower()
    if not raw:
        return None
    named = NAMED_COLORS.get(raw.lstrip("#"))
    if named:
        return int(named, 16)
    import re
    rgb = re.fullmatch(r"rgba?\(\s*(\d{1,3})\s*[,\s]\s*(\d{1,3})\s*[,\s]\s*(\d{1,3})(?:\s*[,/]\s*[\d.]+)?\s*\)", raw)
    if rgb:
        channels = [int(x) for x in rgb.groups()]
        if all(0 <= x <= 255 for x in channels):
            return (channels[0] << 16) | (channels[1] << 8) | channels[2]
        return None
    raw = raw.removeprefix("#").removeprefix("0x")
    if len(raw) == 3 and all(ch in "0123456789abcdef" for ch in raw):
        raw = "".join(ch * 2 for ch in raw)
    if len(raw) == 8 and all(ch in "0123456789abcdef" for ch in raw):
        raw = raw[:6]
    if len(raw) == 6 and all(ch in "0123456789abcdef" for ch in raw):
        return int(raw, 16)
    return None


def _image_catalog_prompt(character_id: str | None = None) -> str:
    directory = _character_image_dir(character_id)
    manifest = directory / "manifest.json"
    try:
        data = json.loads(manifest.read_text("utf-8"))
        if not isinstance(data, dict):
            data = {}
    except (OSError, ValueError):
        data = {}
    entries = []
    for name in _image_names(character_id):
        raw = data.get(name)
        usage = raw.strip() if isinstance(raw, str) else ""
        usage = re.sub(r"//group\s*=\s*([^\s/]+)", "", usage).strip()
        entries.append(f"- {name}: {usage}" if usage else f"- {name} (ไม่มีคำอธิบาย)")
    return "\n".join(entries) if entries else "(ไม่มีรูปภาพให้ใช้ — ส่ง none เสมอ)"


def build_context(history: list[dict], current: str, user_name: str, timestamp: str,
                  memory_items: list[dict], profile: dict | None,
                  group_profiles: list[dict], group: bool, media_summary: str = "") -> str:
    lines = ["บทสนทนาก่อนหน้า:"]
    for item in history:
        if item.get("role") == "model":
            role = item.get("user_name") or "Isla"
        else:
            role = item.get("user_name") or "User"
            if item.get("user_id"):
                role += f" [Discord User ID: {item['user_id']}]"
        date = thai_timestamp(item.get("timestamp"))
        text = str(item.get("text") or "")
        if item.get("file_name"):
            text += f" [file: {item['file_name']}]"
        lines.append(f"[{date}] {role}: {text}")
    lines.extend(["", f"ข้อความล่าสุดจาก {user_name} ({timestamp}):", current or "(ไม่มีข้อความแนบมา)"])
    if media_summary:
        lines.extend(["", f"ผู้ใช้แนบไฟล์: {media_summary}"])
    if memory_items:
        lines.extend(["", "<retrieved_memories>"])
        for memory in memory_items:
            lines.append(f"- {memory.get('timestamp','')}: {memory.get('text','')} (relevance={memory.get('score',1):.2f})")
        lines.append("</retrieved_memories>")
    if group:
        lines.extend(["", "<group_session>"])
        for item in group_profiles:
            lines.append(f"<user id={item['user_id']} name={item['user_name']}>")
            lines.append(f"nicknames={', '.join(item.get('nickname', []))}")
            lines.extend(f"fact={f['text']}" for f in item["facts"] if f.get("status") != "historical")
            lines.append("</user>")
        lines.append("</group_session>")
    if profile:
        lines.extend(["", "<user_profile>", f"userId={profile['user_id']}", f"name={profile['user_name']}",
                      f"nicknames={', '.join(profile.get('nickname', []))}"])
        for fact in profile["facts"]:
            lines.append(f"fact[{fact.get('status','confirmed')}]: {fact['text']}")
        lines.append("</user_profile>")
    return "\n".join(lines)


def _live_parts(input_parts: list[dict]):
    import base64
    parts = []
    for item in input_parts:
        kind = item.get("type")
        if kind == "text":
            parts.append(types.Part.from_text(text=str(item.get("text", ""))))
        elif kind == "image":
            data = item.get("data")
            if isinstance(data, str):
                data = base64.b64decode(data)
            if data:
                parts.append(types.Part.from_bytes(data=data, mime_type=item.get("mime_type") or "image/jpeg"))
    return parts


async def _create_live_response(stage: str, input_parts: list[dict], system_instruction: str,
                                response_schema: dict | None = None,
                                debug_context: dict | None = None) -> str:
    key_attempts = 0
    retry = 0
    attempt = 0
    max_keys = max(1, len(_keys(stage)))
    chosen_model = config.gemini2_model if stage == "gemini2" else config.gemini1_model
    content_parts = _live_parts(input_parts)
    if response_schema:
        system_instruction = "\n\n".join([
            system_instruction,
            "ส่งคำตอบเป็น JSON ที่ถูกต้องเท่านั้น ห้ามใส่ Markdown หรือข้อความนอก JSON และต้องทำตาม JSON Schema นี้:",
            json.dumps(response_schema, ensure_ascii=False, separators=(",", ":")),
        ])
    # Aira opens one Live connection per generated turn. Compression protects
    # the Live session when a large seeded context approaches the model window;
    # cross-turn resumption is intentionally not enabled here because every
    # Aira call already seeds its own authoritative transcript and memories.
    # Reusing a prior handle while resending that transcript would duplicate
    # conversation state and can corrupt character continuity.
    live_config = types.LiveConnectConfig(
        response_modalities=[types.Modality.AUDIO],
        output_audio_transcription=types.AudioTranscriptionConfig(),
        system_instruction=system_instruction,
        context_window_compression=types.ContextWindowCompressionConfig(
            trigger_tokens=100_000,
            sliding_window=types.SlidingWindow(target_tokens=80_000),
        ),
    )
    while key_attempts < max_keys:
        client = _live_client(stage)
        attempt += 1
        debug_meta = {
            "stage": stage, "model": chosen_model, "api": "live", "api_version": "v1beta",
            "response_modalities": ["AUDIO"], "output_audio_transcription": True,
            "attempt": attempt, "userId": (debug_context or {}).get("user_id"),
            "userName": (debug_context or {}).get("user_name"),
            "turnId": (debug_context or {}).get("turn_id"),
        }
        debug_dump({**debug_meta, "event": "request", "payload": {
            "system_instruction": system_instruction,
            "parts": [{"text": p.text} if p.text is not None else {"mime_type": p.inline_data.mime_type} for p in content_parts],
        }})
        # TPM is input-token throughput. Do not reserve output/thinking tokens here.
        estimate = estimate_live_request_tokens(system_instruction, content_parts, output_reserve=0)
        input_limit = await _model_input_limit(client, chosen_model)
        context_budget = max(1, int(input_limit * 0.90))
        if estimate > context_budget:
            raise ValueError(
                f"Gemini input estimate ({estimate}) exceeds the safe context budget "
                f"({context_budget}/{input_limit}); trim conversation history or attachments"
            )
        reservation = await live_token_budget.reserve(estimate, label=stage)
        usage_tokens = None
        usage_detail = None
        try:
            output = []
            async with client.aio.live.connect(model=chosen_model, config=live_config) as session:
                await session.send_client_content(
                    turns=types.Content(role="user", parts=content_parts),
                    turn_complete=True,
                )
                async with asyncio.timeout(120):
                    async for message in session.receive():
                        metadata = getattr(message, "usage_metadata", None)
                        if metadata is not None:
                            usage_detail = usage_metrics(metadata)
                            current_input = usage_tpm_tokens(metadata)
                            if current_input is not None:
                                usage_tokens = current_input
                        server_content = getattr(message, "server_content", None)
                        if server_content:
                            transcription = getattr(server_content, "output_transcription", None)
                            transcript_text = getattr(transcription, "text", None) if transcription else None
                            if transcript_text:
                                output.append(transcript_text)
                            else:
                                model_turn = getattr(server_content, "model_turn", None)
                                for part in (getattr(model_turn, "parts", None) or []) if model_turn else []:
                                    if getattr(part, "text", None):
                                        output.append(part.text)
                        if server_content and getattr(server_content, "turn_complete", False):
                            break
            await live_token_budget.settle(reservation, usage_tokens)
            result = "".join(output).strip()
            debug_dump({**debug_meta, "event": "response", "text": result,
                        "estimated_tokens": estimate, "usage_tokens": usage_tokens})
            usage_detail = usage_detail or {}
            log.info(
                "Gemini Live usage: stage=%s model=%s input_tpm=%s estimated_input=%s "
                "output=%s thinking=%s tool_input=%s cached=%s total=%s "
                "context_estimate=%s/%s remaining_tpm=%s/%s",
                stage, chosen_model, usage_tokens if usage_tokens is not None else "unreported",
                estimate, usage_detail.get("output", "unreported"),
                usage_detail.get("thinking", "unreported"),
                usage_detail.get("tool_input", "unreported"),
                usage_detail.get("cached", "unreported"),
                usage_detail.get("total", "unreported"), estimate, input_limit,
                live_token_budget.available_tokens(), live_token_budget.capacity,
            )
            if not result:
                raise RuntimeError("Gemini Live completed without a text response")
            return result
        except Exception as exc:
            status = _status(exc)
            await live_token_budget.settle(
                reservation, 0 if status == 429 and usage_tokens is None else usage_tokens,
            )
            debug_dump({**debug_meta, "event": "error", "error": {
                "name": type(exc).__name__, "status": status, "message": str(exc),
            }})
            if status == 429 and key_attempts + 1 < max_keys:
                _rotate(stage)
                key_attempts += 1
                continue
            if status and 500 <= status <= 599 and retry < 3:
                await asyncio.sleep(0.25 * (2 ** retry) + random.random() * 0.1)
                retry += 1
                continue
            raise
    raise RuntimeError(f"All API keys rate limited for {stage}")


async def generate_text(stage: str, prompt: str, system_instruction: str,
                        media_parts: list[dict] | None = None, schema: dict | None = None,
                        debug_context: dict | None = None) -> str:
    parts = [{"type": "text", "text": prompt}, *(media_parts or [])]
    return await _create_live_response(
        stage, parts, system_instruction, response_schema=schema,
        debug_context=debug_context,
    )


async def embed(text: str, task: str = "query") -> list[float]:
    if task == "query":
        prompt = f"task: search result | query: {text}"
    elif task == "document":
        prompt = f"title: none | text: {text}"
    else:
        raise ValueError(f"Unsupported embedding task: {task}")
    attempts = len(_keys("embedding2"))
    last_error = None
    for _ in range(attempts):
        client = _client("embedding2")
        try:
            result = await client.aio.models.embed_content(
                model=config.embedding_model,
                contents=prompt,
                config=types.EmbedContentConfig(output_dimensionality=config.embedding_dimension),
            )
            embeddings = getattr(result, "embeddings", None) or []
            values = getattr(embeddings[0], "values", None) if embeddings else None
            if not values:
                raise RuntimeError("Gemini Embedding returned no vector")
            return list(values)
        except Exception as exc:
            last_error = exc
            if _status(exc) != 429:
                raise
            _rotate("embedding2")
    raise RuntimeError("All Gemini Embedding API keys were rate-limited") from last_error




PARTIAL_REPLY = re.compile(r'"reply"\s*:\s*"((?:[^"\\]|\\.)*)')


def _salvage_reply(raw: str) -> str:
    """Recover the spoken sentence from an answer the transcription cut short."""
    match = PARTIAL_REPLY.search(raw or "")
    if not match:
        return ""
    try:
        return json.loads('"' + match.group(1) + '"').strip()
    except ValueError:  # the cut left an escape sequence unfinished
        return match.group(1).strip()


def _salvage_character_reply(raw: str) -> dict | None:
    """Keep the reply text when the audio transcription stopped inside the JSON object."""
    reply = _salvage_reply(raw)
    if not reply:
        return None
    log.warning("Salvaged a truncated character answer: chars=%s raw_chars=%s", len(reply), len(raw or ""))
    return {"reply": reply, "summary": "", "memory": "", "relationship": "",
            "character_relationships": [], "next_speaker_id": "", "mood": "",
            "color": None, "select_image": "none"}


async def generate_json(stage: str, prompt: str, system_instruction: str,
                        media_parts: list[dict] | None = None, schema: dict | None = None,
                        debug_context: dict | None = None, attempts: int = 2,
                        salvage=None, retry_guard=None) -> dict | None:
    """Return a parsed JSON answer, retrying the lossy audio transcription channel.

    The live model answers with audio and the JSON only arrives as its transcription, so an
    answer can be cut off mid-object. A second request usually completes the same decision;
    callers that can live with partial data pass ``salvage`` to keep what did arrive.

    ``retry_guard`` is asked before the second request; when the room moved on while the
    first answer was generated, asking again would only produce a duplicate turn.
    """
    raw = ""
    for attempt in range(1, attempts + 1):
        raw = await generate_text(stage, prompt, system_instruction, media_parts=media_parts,
                                  schema=schema, debug_context=debug_context)
        parsed = _extract_object(raw)
        if parsed is not None:
            return parsed
        log.warning("Structured Gemini answer was not parseable JSON: stage=%s attempt=%s/%s chars=%s",
                    stage, attempt, attempts, len(raw))
        if attempt < attempts and retry_guard is not None and retry_guard():
            log.info("Not retrying the structured answer: newer messages are waiting")
            break
    return salvage(raw) if salvage is not None else None


async def generate_character_reply(prompt: str, context: str,
                                   media_parts: list[dict] | None = None,
                                   debug_context: dict | None = None,
                                   retry_guard=None) -> dict:
    schema = {"type": "object", "properties": {
        "reply": {"type": "string"}, "summary": {"type": "string"},
        "memory": {"type": "string"}, "relationship": {"type": "string"},
        "character_relationships": {"type": "array", "items": {"type": "object", "properties": {
            "target_character_id": {"type": "string"}, "relationship": {"type": "string"}
        }, "required": ["target_character_id", "relationship"]}},
        "next_speaker_id": {"type": "string", "description": "ID ของตัวละครอื่นที่ควรพูดต่อ หรือสตริงว่างเมื่อบทสนทนาจบ"},
        "mood": {"type": "string", "description": "อารมณ์ภาษาไทยสั้น ๆ 1-3 คำ"},
        "color": {"type": "string", "description": "สี HEX 6 หลักที่สื่ออารมณ์ เช่น #F1C40F"},
        "select_image": {"type": "string", "description": "ชื่อไฟล์รูปแสดงสีหน้าจากรายการที่ให้ไว้ หรือ none"},
        "rps": {"type": "string", "enum": ["rock", "paper", "scissors"]},
    }, "required": ["reply", "summary", "memory", "relationship", "character_relationships",
                   "next_speaker_id", "mood", "color", "select_image"]}
    parsed = await generate_json("gemini1", context, prompt, media_parts=media_parts,
                                 schema=schema, debug_context=debug_context,
                                 salvage=_salvage_character_reply, retry_guard=retry_guard)
    if not parsed:
        # Never expose malformed model output (including fenced/raw JSON) as a Discord reply.
        log.error("Gemini character response was not valid JSON; refusing to publish raw output")
        raise ValueError("Gemini returned an invalid character response; raw output was not sent")
    facts = []
    for item in (parsed.get("add_facts") or parsed.get("facts") or [])[:3]:
        if isinstance(item, dict):
            text = str(item.get("text") or "").strip()[:1000]
            owner = str(item.get("owner_user_id") or item.get("ownerUserId") or "").strip()
            if text and owner:
                facts.append({"text": text, "owner_user_id": owner,
                              "confirmed_by_owner": item.get("confirmed_by_owner", item.get("confirmedByOwner", False)) is True,
                              "replaces_fact": str(item.get("replaces_fact") or item.get("replacesFact") or "").strip()})
    raw_nicknames = parsed.get("add_nicknames") or parsed.get("nicknames") or []
    if isinstance(raw_nicknames, str):
        raw_nicknames = [raw_nicknames]
    nicknames = [str(item).strip()[:80] for item in raw_nicknames
                 if isinstance(item, str) and item.strip()][:8] if isinstance(raw_nicknames, list) else []
    relationships = []
    for item in parsed.get("character_relationships", []) or []:
        if isinstance(item, dict):
            target = str(item.get("target_character_id") or "").strip()
            value = str(item.get("relationship") or "").strip()
            if target and value:
                relationships.append({"target_character_id": target, "relationship": value})
    rps = parsed.get("rps")
    return {"reply": str(parsed.get("reply") or "").strip(),
            "summary": str(parsed.get("summary") or "").strip(),
            "memory": str(parsed.get("memory") or "").strip(),
            "relationship": str(parsed.get("relationship") or "").strip()[:1200],
            "relationships": relationships, "facts": facts, "nicknames": nicknames,
            "next_speaker_id": str(parsed.get("next_speaker_id") or "").strip(),
            "mood": str(parsed.get("mood") or "").strip()[:60],
            "color": normalize_color(parsed.get("color")),
            "image": _normalize_image(
                str(parsed.get("select_image") or parsed.get("image") or ""),
                str((debug_context or {}).get("character_id") or "isla"),
            ),
            "rps": rps if rps in {"rock", "paper", "scissors"} else None}
