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
from .relationships import (
    BOND_LEVELS, CRUSH_XP_THRESHOLD, FLIRT_REQUIREMENT, LOVER_XP_THRESHOLD,
    SOULMATE_XP_THRESHOLD, SPECIAL_XP, XP_THRESHOLDS, bond_for_xp,
    relationship_permissions,
)
from .store import utc_now
from .thought_signatures import add_thought_signature, rotate_thought_signatures
from .debug_dump import debug_dump

log = logging.getLogger("aira.gemini")
_clients: dict[str, genai.Client] = {}
_key_state = {"gemini1": 0, "gemini2": 0, "embedding2": 0}
try:
    _key_state.update(json.loads(config.key_state_file.read_text("utf-8")))
except (OSError, ValueError, TypeError):
    pass

REPLY_SCHEMA = {
    "type": "object",
    "properties": {
        "Isla": {"type": "string", "description": "ข้อความตอบกลับของไอล่าถึง {{partner}} คงคาแรคเตอร์และน้ำเสียงของไอล่า"},
        "summery": {"type": "string", "description": "สรุปสั้น ๆ หนึ่งบรรทัดของบทสนทนาในเทิร์นนี้"},
        "mood": {"type": "string", "description": "อารมณ์ภาษาไทยสั้น ๆ 1-3 คำ"},
        "color": {"type": "string", "description": "สีแทนอารมณ์ hex 6 หลัก เช่น #F1C40F"},
        "rps": {"type": "string", "enum": ["rock", "paper", "scissors"]},
    },
    "required": ["Isla", "summery", "mood", "color"],
}

STATE_SCHEMA = {
    "type": "object",
    "properties": {
        "affinity": {"type": "number", "description": "คะแนนความสัมพันธ์ที่เปลี่ยนในเทิร์นนี้ (-100 ถึง 100)"},
        "is_flirt": {"type": "boolean", "description": "true เมื่อ {{partner}} เป็นฝ่ายจีบหรือเข้าหาเชิงชู้สาวในเทิร์นนี้"},
        "approve_lover": {"type": "boolean"},
        "approve_soulmate": {"type": "boolean"},
        "approve_sibling": {"type": "boolean"},
        "approve_family": {"type": "boolean"},
        "select_image": {"type": "string", "description": "Known local expression image filename or none"},
        "add_facts": {"type": "array", "items": {"type": "object", "properties": {
            "text": {"type": "string"}, "owner_user_id": {"type": "string"},
            "confirmed_by_owner": {"type": "boolean"}, "replaces_fact": {"type": "string"},
        }, "required": ["text", "owner_user_id", "confirmed_by_owner"]}},
        "add_nicknames": {"type": "array", "items": {"type": "string"}},
        "ingest_memory": {"type": "string"},
    },
    "required": ["affinity", "select_image"],
}

NO_IMAGE = "none"


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


def _fill_partner(value, partner: str):
    if isinstance(value, str):
        return fill_partner(value, partner)
    if isinstance(value, list):
        return [_fill_partner(item, partner) for item in value]
    if isinstance(value, dict):
        return {key: _fill_partner(item, partner) for key, item in value.items()}
    return value


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


def _to_number(value) -> int | None:
    import math
    try:
        number = float(value)
        return math.floor(number + 0.5)
    except (TypeError, ValueError, OverflowError):
        return None


def _image_names() -> list[str]:
    extensions = {".jpg", ".jpeg", ".png", ".webp", ".gif"}
    if not config.images_dir.is_dir():
        return []
    return sorted(
        path.name for path in config.images_dir.iterdir()
        if path.is_file() and path.suffix.lower() in extensions
    )


def _normalize_image(value: str | None) -> str:
    if not value or value.strip().lower() in {"none", "no_image", "null"}:
        return ""
    value = Path(value.strip()).name
    return value if value in _image_names() else ""


def parse_reply(raw: str) -> dict:
    parsed = _extract_object(raw)
    if not parsed:
        return {"text": (raw or "").strip(), "summary": "", "mood": "", "color": None, "rps": None, "parsed": False}
    text = _pick(parsed, "Isla", "isla", "reply", "message", "text", "response")
    summary = _pick(parsed, "summery", "summary", "recap", "note", "memory")
    mood = _pick(parsed, "mood", "emotion", "feeling", "อารมณ์")
    color = _pick(parsed, "color")
    rps = _pick(parsed, "rps", "RPS")
    return {
        "text": str(text or "").strip(),
        "summary": str(summary or "").strip(),
        "mood": str(mood or "").strip()[:60],
        "color": normalize_color(color),
        "rps": rps if rps in {"rock", "paper", "scissors"} else None,
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


def required_state_fields(bond: str) -> list[str]:
    required = ["affinity", "select_image"]
    if bond not in {"enemy", "sibling", "family"}:
        required.append("is_flirt")
    if bond == "crush":
        required.append("approve_lover")
    if bond == "lover":
        required.append("approve_soulmate")
    return required


def _state_schema(bond: str) -> dict:
    import copy
    schema = copy.deepcopy(STATE_SCHEMA)
    schema["required"] = required_state_fields(bond)
    return schema


def parse_state(raw: str, bond: str) -> dict:
    obj = _extract_object(raw)
    empty = {"affinity": 0, "is_flirt": False, "approvals": {}, "image": "",
             "facts": [], "nicknames": [], "memory": "", "parsed": False, "warnings": ["reply was not JSON"]}
    if obj is None:
        return empty
    warnings = []
    affinity_raw = _to_number(_pick(obj, "affinity", "xp", "delta", "relationship", "relation", "xp_delta", "relationship_delta"))
    if affinity_raw is None:
        affinity = 0
        warnings.append("missing affinity")
    else:
        affinity = max(-100, min(100, affinity_raw))
        if affinity > 0 and affinity < 10:
            affinity = 10
    if bond not in {"enemy", "sibling", "family"}:
        is_flirt = _to_bool(_pick(obj, "is_flirt", "isFlirt", "flirt", "flirtatious")) is True
    else:
        is_flirt = False
    approvals = {
        "lover": _to_bool(_pick(obj, "approve_lover", "approveLover", "lover_accepted", "accept_lover")) is True if bond == "crush" else False,
        "soulmate": _to_bool(_pick(obj, "approve_soulmate", "approveSoulmate", "soulmate_accepted", "accept_soulmate")) is True if bond == "lover" else False,
        "sibling": _to_bool(_pick(obj, "approve_sibling", "approveSibling", "sibling_accepted", "accept_sibling")) is True,
        "family": _to_bool(_pick(obj, "approve_family", "approveFamily", "family_accepted", "accept_family")) is True,
    }
    facts = _pick(obj, "add_facts", "addFacts", "facts") or []
    proposals = []
    if isinstance(facts, list):
        for fact in facts[:3]:
            if not isinstance(fact, dict):
                continue
            text = str(fact.get("text") or "").strip()
            owner = str(fact.get("owner_user_id") or fact.get("ownerUserId") or "").strip()
            confirmed = _to_bool(fact.get("confirmed_by_owner", fact.get("confirmedByOwner")))
            if text and owner and confirmed is not None:
                proposals.append({"text": text, "owner_user_id": owner, "confirmed_by_owner": confirmed,
                                  "replaces_fact": str(fact.get("replaces_fact") or fact.get("replacesFact") or "").strip()})
    nicknames = _pick(obj, "add_nicknames", "addNicknames", "nicknames", "nickname") or []
    if isinstance(nicknames, str): nicknames = [nicknames]
    nicknames = [x.strip() for x in nicknames if isinstance(x, str) and x.strip()] if isinstance(nicknames, list) else []
    memory = _pick(obj, "ingest_memory", "ingestMemory", "memory") or ""
    image = _normalize_image(str(_pick(obj, "select_image", "selectImage", "image", "expression") or ""))
    if not image:
        warnings.append("no known expression image")
    return {"affinity": affinity, "is_flirt": is_flirt, "approvals": approvals,
            "image": image, "facts": proposals, "nicknames": nicknames,
            "memory": str(memory).strip(), "parsed": True, "warnings": warnings}


def _image_catalog_prompt() -> str:
    manifest = config.images_dir / "manifest.json"
    try:
        data = json.loads(manifest.read_text("utf-8"))
        if not isinstance(data, dict):
            data = {}
    except (OSError, ValueError):
        data = {}
    entries = []
    for name in _image_names():
        raw = data.get(name)
        usage = raw.strip() if isinstance(raw, str) else ""
        usage = re.sub(r"//group\s*=\s*([^\s/]+)", "", usage).strip()
        entries.append(f"- {name}: {usage}" if usage else f"- {name} (ไม่มีคำอธิบาย)")
    return "\n".join(entries) if entries else "(ไม่มีรูปภาพให้ใช้ — ส่ง none เสมอ)"


def _xp_range(bond: str) -> str:
    if bond == "enemy":
        return f"<= {XP_THRESHOLDS[-1]}"
    bounds = {
        "stranger": (XP_THRESHOLDS[-1] + 1, XP_THRESHOLDS[1] - 1),
        "acquaintance": (XP_THRESHOLDS[1], XP_THRESHOLDS[2] - 1),
        "friend": (XP_THRESHOLDS[2], XP_THRESHOLDS[3] - 1),
        "close_friend": (XP_THRESHOLDS[3], None),
    }
    low, high = bounds[bond]
    return f">= {low}" if high is None else f"{low}..{high}"


def _bond_ladder_with_thresholds(partner: str) -> str:
    who = _partner(partner)
    lines = []
    for name in ("stranger", "acquaintance", "friend", "close_friend", "crush",
                 "lover", "soulmate", "sibling", "family", "enemy"):
        info = BOND_LEVELS[name]
        head = f"- {name} (ระดับ {info['level']}) = {info['label']}"
        if name in {"stranger", "acquaintance", "friend", "close_friend", "enemy"}:
            line = f"{head} — xp {_xp_range(name)}"
        elif name == "crush":
            line = f"{head} — xp >= {CRUSH_XP_THRESHOLD} และ {who} จีบสะสม >= {FLIRT_REQUIREMENT} ครั้ง"
        elif name == "lover":
            line = f"{head} — ต้องเป็น crush ก่อน + {who} ขอคบ + Isla ตอบตกลง (xp >= {LOVER_XP_THRESHOLD})"
        elif name == "soulmate":
            line = f"{head} — ต้องเป็น lover ก่อน + {who} ขอแต่งงาน + Isla ตอบตกลง (xp >= {SOULMATE_XP_THRESHOLD})"
        else:
            label = "ขอเป็นพี่น้อง" if name == "sibling" else "ขอเป็นครอบครัว"
            line = f"{head} — xp >= {SPECIAL_XP} + {label} + Isla ตอบตกลง (ไประดับ lover ไม่ได้)"
        if info.get("max_level") is not None:
            line += f" — ไปต่อได้ถึงระดับ {info['max_level']} เท่านั้น"
        lines.append(line)
    return "\n".join(lines)


def state_prompt_values(bond: str, xp: int, flirt_count: int, user_id: str,
                        partner: str = "เพื่อน") -> str:
    who = _partner(partner)
    tiers = (
        "การคุยปกติ/ไม่ใช่ด้านลบ +10..+100; ด้านลบเล็กน้อย -9..-1; "
        "ด่า/ทำร้ายความรู้สึก -40..-10; หยาบคายมาก/ดูถูกซ้ำ ๆ -100..-41"
    )
    values = {
        "partner": who,
        "affinity_min": "-100", "affinity_max": "100", "affinity_floor": "10",
        "affinity_tiers": tiers, "facts_per_turn": "3", "no_image": NO_IMAGE,
        "bond_ladder": _bond_ladder_with_thresholds(who),
        "flirt_requirement": str(FLIRT_REQUIREMENT), "proposal_xp": str(LOVER_XP_THRESHOLD),
        "enemy_xp": str(XP_THRESHOLDS[-1]), "recovery_bond": "friend",
        "capped_level": str(BOND_LEVELS["sibling"]["max_level"]),
        "expression_images": _image_catalog_prompt(),
    }
    prompt = fill_partner(_read_prompt(config.gemini2_prompt, "Gemini 2"), who)
    missing = []

    def substitute(match):
        key = match.group(1)
        value = values.get(key)
        if value is None or value == "":
            if key not in missing:
                missing.append(key)
            return match.group(0)
        return str(value)

    rendered = re.sub(r"{{\s*([A-Za-z0-9_.-]+)\s*}}", substitute, prompt)
    if missing:
        log.warning("Gemini 2 prompt has unresolved placeholders: %s", ", ".join(missing))
    return rendered.strip()


def build_context(history: list[dict], current: str, user_name: str, timestamp: str,
                  memory_items: list[dict], profile: dict | None,
                  group_profiles: list[dict], group: bool, media_summary: str = "") -> str:
    lines = ["บทสนทนาก่อนหน้า:"]
    for item in history[-50:]:
        role = (item.get("user_name") or "Isla") if item.get("role") == "model" else (item.get("user_name") or "User")
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
            lines.append(f"relationship={item['bond']}; xp={item['xp']}; nicknames={', '.join(item['nickname'])}")
            lines.extend(f"fact={f['text']}" for f in item["facts"] if f.get("status") != "historical")
            lines.append("</user>")
        lines.append("</group_session>")
    if profile:
        lines.extend(["", "<user_profile>", f"userId={profile['user_id']}", f"name={profile['user_name']}",
                      f"bond={profile['bond']}", f"xp={profile['xp']}", f"flirt_count={profile['flirt_count']}",
                      f"nicknames={', '.join(profile['nickname'])}"])
        for fact in profile["facts"]:
            lines.append(f"fact[{fact.get('status','confirmed')}]: {fact['text']}")
        permissions = relationship_permissions(profile["bond"], profile["xp"], profile["flirt_count"])
        lines.extend(f"can_accept_{key}={str(value).lower()}" for key, value in permissions.items())
        lines.append("</user_profile>")
    return "\n".join(lines)


def _temporary_context(steps: list[dict] | None) -> str:
    """Convert locally executed memory-tool results into ordinary Live API context."""
    if not steps:
        return ""
    results = []
    for step in steps:
        if step.get("type") != "function_result":
            continue
        for item in step.get("result", []) or []:
            if item.get("type") == "text" and item.get("text"):
                results.append(f"ผลจาก {step.get('name', 'เครื่องมือ')}:\n{item['text']}")
    return "\n\nข้อมูลบริบทจากระบบความจำ (ผลจากเครื่องมือที่ระบบเรียกใช้แล้ว):\n" + "\n\n".join(results) if results else ""


def _live_parts(input_parts: list[dict], temporary_steps: list[dict] | None):
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
    extra = _temporary_context(temporary_steps)
    if extra:
        parts.append(types.Part.from_text(text=extra))
    return parts


async def _create_live_response(stage: str, input_parts: list[dict], system_instruction: str,
                                response_schema: dict | None = None,
                                temporary_steps: list[dict] | None = None,
                                debug_context: dict | None = None) -> str:
    key_attempts = 0
    retry = 0
    attempt = 0
    max_keys = max(1, len(_keys(stage)))
    chosen_model = config.gemini2_model if stage == "gemini2" else config.gemini1_model
    content_parts = _live_parts(input_parts, temporary_steps)
    if response_schema:
        system_instruction = "\n\n".join([
            system_instruction,
            "ส่งคำตอบเป็น JSON ที่ถูกต้องเท่านั้น ห้ามใส่ Markdown หรือข้อความนอก JSON และต้องทำตาม JSON Schema นี้:",
            json.dumps(response_schema, ensure_ascii=False, separators=(",", ":")),
        ])
    live_config = types.LiveConnectConfig(
        response_modalities=[types.Modality.TEXT],
        system_instruction=system_instruction,
    )
    while key_attempts < max_keys:
        client = _client(stage)
        attempt += 1
        debug_meta = {
            "stage": stage, "model": chosen_model, "api": "live", "response_modalities": ["TEXT"],
            "attempt": attempt, "userId": (debug_context or {}).get("user_id"),
            "userName": (debug_context or {}).get("user_name"),
            "turnId": (debug_context or {}).get("turn_id"),
        }
        debug_dump({**debug_meta, "event": "request", "payload": {
            "system_instruction": system_instruction,
            "parts": [{"text": p.text} if p.text is not None else {"mime_type": p.inline_data.mime_type} for p in content_parts],
        }})
        try:
            output = []
            async with client.aio.live.connect(model=chosen_model, config=live_config) as session:
                await session.send_client_content(
                    turns=types.Content(role="user", parts=content_parts),
                    turn_complete=True,
                )
                async with asyncio.timeout(120):
                    async for message in session.receive():
                        server_content = getattr(message, "server_content", None)
                        model_turn = getattr(server_content, "model_turn", None) if server_content else None
                        for part in (getattr(model_turn, "parts", None) or []) if model_turn else []:
                            if getattr(part, "text", None):
                                output.append(part.text)
                        if server_content and getattr(server_content, "turn_complete", False):
                            break
            result = "".join(output).strip()
            debug_dump({**debug_meta, "event": "response", "text": result})
            if not result:
                raise RuntimeError("Gemini Live completed without a text response")
            return result
        except Exception as exc:
            status = _status(exc)
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
                        temporary_steps: list[dict] | None = None,
                        debug_context: dict | None = None) -> str:
    parts = [{"type": "text", "text": prompt}, *(media_parts or [])]
    return await _create_live_response(
        stage, parts, system_instruction, response_schema=schema,
        temporary_steps=temporary_steps, debug_context=debug_context,
    )


async def embed(text: str, task: str = "query") -> list[float]:
    prompt = f"task: search result | query: {text}" if task == "query" else f"title: none | text: {text}"
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


async def choose_characters_router(message: str, user_name: str, characters: list[dict],
                                   mentioned_ids: list[str] | None = None) -> list[str]:
    mentioned_ids = [value for value in (mentioned_ids or []) if value != "isla"]
    prompt = "\n".join([
        "เลือกตัวละครเสริมที่ควรเข้าร่วมตอบข้อความล่าสุดในบทสนทนา Discord",
        "Isla ตอบอยู่แล้วเสมอ เลือกตัวละครอื่นได้ 0-1 ตัวเท่านั้น (รวมทั้งหมดไม่เกิน 2 ตัวละคร)",
        "ถ้าข้อความเรียกตัวละครโดยตรง ต้องเลือกตัวละครนั้นเสมอ ห้ามละเลยการเรียกชื่อโดยตรง",
        "ถ้าไม่มีตัวละครอื่นที่ควรพูด ให้ส่ง characters เป็น array ว่าง ห้ามเลือกตัวละครเพื่อให้ครบจำนวน",
        "ส่งกลับเฉพาะ JSON {\"characters\":[id]}",
        *[f"- id={c['id']}; name={c['name']}; aliases={', '.join(c['aliases'])}" for c in characters if c['id'] != 'isla'],
        "ตัวละครที่ถูกเรียกโดยตรง (ต้องเลือก): " + (", ".join(mentioned_ids) or "ไม่มี"),
        f"ข้อความล่าสุดจาก {user_name}: {message}",
    ])
    result = await generate_text("gemini2", prompt, "ตอบเป็น JSON เท่านั้น", schema={
        "type": "object", "properties": {"characters": {"type": "array", "items": {"type": "string"}}},
        "required": ["characters"],
    })
    obj = _extract_object(result) or {}
    values = obj.get("characters", [])
    return [str(x) for x in values if isinstance(x, str)] if isinstance(values, list) else []


async def generate_character_reply(prompt: str, context: str,
                                   media_parts: list[dict] | None = None,
                                   temporary_steps: list[dict] | None = None,
                                   debug_context: dict | None = None) -> dict:
    schema = {"type": "object", "properties": {
        "reply": {"type": "string"}, "memory": {"type": "string"}, "relationship": {"type": "string"}
    }, "required": ["reply", "memory", "relationship"]}
    raw = await generate_text("gemini1", context, prompt, media_parts=media_parts,
                              schema=schema, temporary_steps=temporary_steps,
                              debug_context=debug_context)
    parsed = _extract_object(raw)
    if not parsed:
        return {"reply": raw.strip(), "memory": "", "relationship": ""}
    return {"reply": str(parsed.get("reply") or "").strip(),
            "memory": str(parsed.get("memory") or "").strip(),
            "relationship": str(parsed.get("relationship") or "").strip()}


def build_isla_prompt(partner: str) -> str:
    return fill_partner(_read_prompt(config.gemini1_prompt, "Gemini 1"), partner)


async def generate_isla_reply(context: str, partner: str, media_parts: list[dict] | None = None,
                              temporary_steps: list[dict] | None = None,
                              system_context: str = "",
                              debug_context: dict | None = None) -> dict:
    schema = _fill_partner(REPLY_SCHEMA, partner)
    system = build_isla_prompt(partner) + ("\n\n" + system_context if system_context else "")
    return parse_reply(await generate_text("gemini1", context, system,
                                            media_parts=media_parts, schema=schema,
                                            temporary_steps=temporary_steps,
                                            debug_context=debug_context))


async def analyze_turn(context: str, partner: str, bond: str, xp: int,
                       flirt_count: int, media_parts: list[dict] | None = None,
                       user_id: str = "", debug_context: dict | None = None) -> dict:
    system = state_prompt_values(bond, xp, flirt_count, user_id, partner)
    return parse_state(await generate_text("gemini2", context, system, media_parts=media_parts,
                                           schema=_fill_partner(_state_schema(bond), partner),
                                           debug_context=debug_context), bond)
