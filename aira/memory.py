from __future__ import annotations

import json
import logging
import math
import re
import uuid
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from .config import ROOT, config
from .gemini import embed
from .store import store

log = logging.getLogger("aira.memory")
LEGACY_SESSION_KEY = "legacy:unattributed"


def _initialize_tables() -> None:
    store.db.executescript("""
        CREATE TABLE IF NOT EXISTS semantic_memories(
            id TEXT PRIMARY KEY, text TEXT NOT NULL, embedding_json TEXT NOT NULL,
            user_id TEXT, timestamp TEXT NOT NULL, session_key TEXT NOT NULL,
            metadata_json TEXT NOT NULL DEFAULT '{}'
        );
        CREATE INDEX IF NOT EXISTS idx_semantic_session ON semantic_memories(session_key);
        CREATE INDEX IF NOT EXISTS idx_semantic_user ON semantic_memories(user_id);
        CREATE INDEX IF NOT EXISTS idx_semantic_timestamp ON semantic_memories(timestamp);
        CREATE TABLE IF NOT EXISTS episodic_memories(
            id TEXT PRIMARY KEY, text TEXT NOT NULL, embedding_json TEXT NOT NULL,
            session_key TEXT NOT NULL, date TEXT NOT NULL, period TEXT NOT NULL,
            start_time TEXT NOT NULL, end_time TEXT NOT NULL, participants_json TEXT NOT NULL,
            created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_episodes_session ON episodic_memories(session_key);
        CREATE INDEX IF NOT EXISTS idx_episodes_date ON episodic_memories(date, period);
    """)
_initialize_tables()


def _vector_json(vector: list[float]) -> str:
    values = [float(value) for value in vector]
    if not values or not all(math.isfinite(value) for value in values):
        raise ValueError("Embedding vector is empty or contains non-finite values")
    return json.dumps(values, separators=(",", ":"))


def _cosine_similarity(left: list[float], right: list[float]) -> float:
    if len(left) != len(right) or not left:
        return 0.0
    dot = sum(a * b for a, b in zip(left, right))
    norm_left = math.sqrt(sum(a * a for a in left))
    norm_right = math.sqrt(sum(b * b for b in right))
    if not norm_left or not norm_right:
        return 0.0
    return max(-1.0, min(1.0, dot / (norm_left * norm_right)))


def similarity_of(distance) -> float:
    if distance is None:
        return 0.0
    try:
        return float(distance)
    except (ValueError, TypeError):
        return 0.0


def _session_where(session_key: str) -> dict:
    return {"sessionKey": session_key}


async def save_memory(text: str, user_id: str, timestamp: str, session_key: str,
                      metadata: dict | None = None, memory_id: str | None = None) -> str:
    vector = await embed(text, "document")
    return save_memory_vector(text, vector, user_id, timestamp, session_key, metadata, memory_id)


def save_memory_vector(text: str, vector: list[float], user_id: str, timestamp: str,
                       session_key: str, metadata: dict | None = None, memory_id: str | None = None) -> str:
    ident = memory_id or str(uuid.uuid4())
    meta = {"userId": str(user_id) if user_id is not None else "", "timestamp": timestamp, "sessionKey": session_key, **(metadata or {})}
    store.db.execute("""INSERT INTO semantic_memories
        (id,text,embedding_json,user_id,timestamp,session_key,metadata_json)
        VALUES(?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET text=excluded.text,embedding_json=excluded.embedding_json,
        user_id=excluded.user_id,timestamp=excluded.timestamp,session_key=excluded.session_key,
        metadata_json=excluded.metadata_json""",
        (ident, text, _vector_json(vector), str(user_id) if user_id is not None else None,
         timestamp, session_key, json.dumps(meta, ensure_ascii=False)))
    return ident


async def search_memories(text: str, session_key: str, limit: int = 8,
                          min_similarity: float | None = None) -> list[dict]:
    if limit <= 0:
        return []
    return search_memories_by_vector(await embed(text, "query"), session_key, limit, min_similarity)


def _semantic_rows(session_key: str | None = None, user_id: str | None = None) -> list[dict]:
    clauses, args = [], []
    if session_key:
        clauses.append("session_key=?"); args.append(session_key)
    if user_id:
        clauses.append("user_id=?"); args.append(str(user_id))
    where = " WHERE " + " AND ".join(clauses) if clauses else ""
    return [dict(row) for row in store.db.execute("SELECT * FROM semantic_memories" + where, args).fetchall()]


def search_memories_by_vector(vector: list[float], session_key: str, limit: int = 8,
                              min_similarity: float | None = None) -> list[dict]:
    if limit <= 0:
        return []
    rows = []
    for item in _semantic_rows(session_key=session_key):
        try: stored = json.loads(item["embedding_json"])
        except (ValueError, TypeError): continue
        score = _cosine_similarity(vector, stored)
        if min_similarity is not None and score < min_similarity:
            continue
        metadata = json.loads(item.get("metadata_json") or "{}")
        rows.append({"id": item["id"], "text": item["text"], "metadata": metadata,
                     "timestamp": item["timestamp"], "user_id": item["user_id"],
                     "session_key": item["session_key"], "score": score})
    rows.sort(key=lambda row: (row["score"], row["timestamp"]), reverse=True)
    return rows[:limit]


async def is_duplicate_memory(vector: list[float], session_key: str) -> dict | None:
    found = search_memories_by_vector(vector, session_key, 1)
    return found[0] if found and found[0]["score"] >= config.memory_dedupe_similarity else None


async def ingest_memory_background(text: str, user_id: str, timestamp: str, session_key: str) -> None:
    """Embed and persist a semantic memory without blocking the Discord reply pipeline."""
    if not text or not text.strip():
        return
    try:
        vector = await embed(text, "document")
        duplicate = await is_duplicate_memory(vector, session_key)
        if duplicate:
            log.info("Skipped duplicate memory for user %s, score=%.2f", user_id, duplicate["score"])
            return
        save_memory_vector(
            text, vector, user_id, timestamp, session_key,
            {"eventTimestamp": timestamp, "createdAt": datetime.now(timezone.utc).isoformat()},
        )
    except Exception:
        log.exception("Memory ingestion failed for user %s", user_id)


async def persist_episode_background(session_key: str, history_session_key: str | None = None,
                                      character_id: str | None = None) -> None:
    """Build and persist one character's episode from the shared room history."""
    try:
        args = (session_key,) if history_session_key is None and character_id is None else (
            session_key, history_session_key, character_id
        )
        episode = await build_recent_episode(*args)
        if episode:
            await save_episode(episode)
    except Exception:
        log.exception("Episode persistence failed for character memory %s", session_key)


def _local_parts(timestamp: str) -> tuple[str, int]:
    try:
        dt = datetime.fromisoformat(timestamp.replace("Z", "+00:00"))
        if dt.tzinfo is None: dt = dt.replace(tzinfo=timezone.utc)
        dt = dt.astimezone(ZoneInfo(config.timezone))
    except (ValueError, TypeError):
        dt = datetime.now(ZoneInfo(config.timezone))
    return dt.strftime("%Y-%m-%d"), dt.hour


def episode_period(timestamp: str) -> str:
    _, hour = _local_parts(timestamp)
    if 5 <= hour < 12: return "morning"
    if 12 <= hour < 17: return "afternoon"
    if 17 <= hour < 22: return "evening"
    return "night"


def episode_id(session_key: str, start_time: str) -> str:
    value = (session_key + "\0" + start_time).encode("utf-16-le")
    hash_value = 2166136261
    for index in range(0, len(value), 2):
        code_unit = value[index] | (value[index + 1] << 8)
        hash_value ^= code_unit
        hash_value = (hash_value * 16777619) & 0xFFFFFFFF
    return "episode-" + format(hash_value, "08x")


def temporal_query(text: str, now: datetime | None = None) -> dict:
    now = (now or datetime.now(timezone.utc)).astimezone(ZoneInfo(config.timezone))
    lowered = text.casefold()
    patterns = [
        (r"เมื่อเช้า|ตอนเช้า|เช้านี้|this morning", "morning", 0),
        (r"เมื่อบ่าย|ตอนบ่าย|บ่ายนี้|this afternoon", "afternoon", 0),
        (r"เมื่อเย็น|ตอนเย็น|เย็นนี้|this evening", "evening", 0),
        (r"เมื่อคืน|ตอนกลางคืน|last night", "night", -1),
        (r"คืนนี้|tonight", "night", 0),
        (r"เมื่อวาน|วานนี้|yesterday", None, -1),
        (r"วันนี้|today", None, 0),
    ]
    for pattern, period, offset in patterns:
        if re.search(pattern, lowered):
            date = (now.date() + timedelta(days=offset)).isoformat()
            return {"date": date, **({"period": period} if period else {})}
    return {}


def build_episode(summaries: list[dict], session_key: str) -> dict | None:
    usable = sorted((item for item in summaries if str(item.get("summary") or "").strip()),
                    key=lambda item: item["timestamp"])
    if not usable: return None
    selected = [usable[-1]]
    gap = config.episode_gap_minutes * 60
    for current in reversed(usable[:-1]):
        first = selected[0]
        if _local_parts(current["timestamp"])[0] != _local_parts(first["timestamp"])[0]:
            break
        if episode_period(current["timestamp"]) != episode_period(first["timestamp"]): break
        t1 = datetime.fromisoformat(current["timestamp"].replace("Z", "+00:00"))
        t2 = datetime.fromisoformat(first["timestamp"].replace("Z", "+00:00"))
        if (t2 - t1).total_seconds() > gap: break
        selected.insert(0, current)
    first, last = selected[0], selected[-1]
    return {"id": episode_id(session_key, first["timestamp"]),
            "text": " ".join(item["summary"].strip() for item in selected),
            "session_key": session_key, "date": _local_parts(last["timestamp"])[0],
            "period": episode_period(last["timestamp"]), "start_time": first["timestamp"],
            "end_time": last["timestamp"],
            "participants": list(dict.fromkeys(item.get("user_id") for item in selected if item.get("user_id"))),
            "created_at": datetime.now(timezone.utc).isoformat()}


def save_episode_vector(episode: dict, vector: list[float]) -> None:
    store.db.execute("""INSERT INTO episodic_memories
        (id,text,embedding_json,session_key,date,period,start_time,end_time,participants_json,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET text=excluded.text,embedding_json=excluded.embedding_json,
        session_key=excluded.session_key,date=excluded.date,period=excluded.period,
        start_time=excluded.start_time,end_time=excluded.end_time,
        participants_json=excluded.participants_json,created_at=excluded.created_at""",
        (episode["id"], episode["text"], _vector_json(vector), episode["session_key"],
         episode["date"], episode["period"], episode["start_time"], episode["end_time"],
         json.dumps(episode.get("participants", [])), episode.get("created_at", "")))


async def save_episode(episode: dict) -> None:
    save_episode_vector(episode, await embed(episode["text"], "document"))


async def build_recent_episode(session_key: str, history_session_key: str | None = None,
                               character_id: str | None = None) -> dict | None:
    history = store.get_history(50, history_session_key or session_key)
    summaries = [
        {"timestamp": row["timestamp"], "summary": row["summary"], "user_id": row["user_id"]}
        for row in history
        if row["role"] == "model" and row.get("summary")
        and (character_id is None or row.get("character_id") == character_id)
    ]
    return build_episode(summaries, session_key)


async def recall_episodes(vector: list[float], session_key: str, query_text: str) -> list[dict]:
    if config.episode_max_results <= 0: return []
    temporal = temporal_query(query_text)
    rows = []
    for item in store.db.execute("SELECT * FROM episodic_memories WHERE session_key=?", (session_key,)).fetchall():
        row = dict(item)
        if temporal.get("date") and row["date"] != temporal["date"]: continue
        if temporal.get("period") and row["period"] != temporal["period"]: continue
        try: stored = json.loads(row["embedding_json"])
        except (ValueError, TypeError): continue
        score = _cosine_similarity(vector, stored)
        if score < config.episode_min_similarity: continue
        rows.append({"id": row["id"], "text": row["text"], "session_key": row["session_key"],
                     "date": row["date"], "period": row["period"], "start_time": row["start_time"],
                     "end_time": row["end_time"], "participants": json.loads(row["participants_json"] or "[]"),
                     "created_at": row["created_at"], "score": score})
    rows.sort(key=lambda row: (row["score"], row["end_time"]), reverse=True)
    return rows[:config.episode_max_results]


async def migrate_memory_sessions() -> dict[str, int]:
    rows = store.db.execute("SELECT id,user_id FROM semantic_memories WHERE session_key IS NULL OR session_key=''").fetchall()
    for row in rows:
        key = f"user:{row['user_id']}" if row["user_id"] else LEGACY_SESSION_KEY
        store.db.execute("UPDATE semantic_memories SET session_key=? WHERE id=?", (key, row["id"]))
    count = int(store.db.execute("SELECT COUNT(*) FROM semantic_memories WHERE session_key IS NOT NULL AND session_key<>''").fetchone()[0])
    return {"backfilled": len(rows), "unattributed": sum(1 for row in rows if not row["user_id"]), "already_keyed": count - len(rows)}


def migrate_character_memory_sessions() -> dict[str, int]:
    """Assign legacy room memories to Isla before enforcing per-character namespaces."""
    migrated = {}
    for table in ("semantic_memories", "episodic_memories"):
        rows = store.db.execute(
            f"SELECT id,session_key FROM {table} WHERE session_key<>? AND session_key NOT LIKE '%:character:%'",
            (LEGACY_SESSION_KEY,),
        ).fetchall()
        for row in rows:
            store.db.execute(
                f"UPDATE {table} SET session_key=? WHERE id=?",
                (f"{row['session_key']}:character:isla", row["id"]),
            )
        migrated[table] = len(rows)
    return migrated


def _episode_rows() -> list[dict]:
    rows = []
    for item in store.db.execute("SELECT * FROM episodic_memories").fetchall():
        row = dict(item)
        participants = json.loads(row.get("participants_json") or "[]")
        rows.append({"id": row["id"], "text": row["text"], "user_id": ",".join(participants),
                     "participants": participants, "session_key": row["session_key"],
                     "timestamp": row["start_time"], "type": "episodic"})
    return rows


def _matches_memory_filter(row: dict, filt: dict) -> bool:
    if filt.get("session_key") and row.get("session_key") != filt["session_key"]: return False
    if filt.get("user_id"):
        user_id = str(filt["user_id"])
        if row.get("type") == "episodic":
            if user_id not in row.get("participants", []): return False
        elif str(row.get("user_id") or "") != user_id: return False
    return True


def count_memories(filter: dict | None = None) -> int:
    filt = filter or {}
    semantic = _semantic_rows(filt.get("session_key"), filt.get("user_id"))
    if filt.get("ids"): semantic = [row for row in semantic if row["id"] in set(filt["ids"])]
    episodes = [row for row in _episode_rows() if _matches_memory_filter(row, filt)]
    if filt.get("ids"): episodes = [row for row in episodes if row["id"] in set(filt["ids"])]
    return len(semantic) + len(episodes)


def list_memories(filter: dict | None = None) -> list[dict]:
    filt = filter or {}
    semantic = _semantic_rows(filt.get("session_key"), filt.get("user_id"))
    if filt.get("ids"): semantic = [row for row in semantic if row["id"] in set(filt["ids"])]
    rows = []
    for row in semantic:
        rows.append({"id": row["id"], "text": row["text"], "user_id": row["user_id"],
                     "session_key": row["session_key"], "timestamp": row["timestamp"], "type": "semantic"})
    rows.extend(row for row in _episode_rows() if _matches_memory_filter(row, filt)
                and (not filt.get("ids") or row["id"] in set(filt["ids"])))
    rows.sort(key=lambda row: str(row.get("timestamp") or ""), reverse=True)
    return rows[:int(filt.get("limit", 20))]


async def search_memories_text(query: str, limit: int = 10, session_key: str | None = None) -> list[dict]:
    if limit <= 0: return []
    vector = await embed(query, "query")
    candidates = _semantic_rows(session_key=session_key)
    rows = []
    for row in candidates:
        try: stored = json.loads(row["embedding_json"])
        except (ValueError, TypeError): continue
        rows.append({"id": row["id"], "text": row["text"], "user_id": row["user_id"],
                     "session_key": row["session_key"], "score": _cosine_similarity(vector, stored)})
    rows.sort(key=lambda row: row["score"], reverse=True)
    return rows[:limit]


def delete_memories(filter: dict | None = None) -> int:
    filt = filter or {}
    if not (filt.get("ids") or filt.get("user_id") or filt.get("session_key")):
        raise ValueError("delete_memories requires an ID, user_id or session_key; use clear_memories() for an explicit full clear")
    semantic = _semantic_rows(filt.get("session_key"), filt.get("user_id"))
    episode = [row for row in _episode_rows() if _matches_memory_filter(row, filt)]
    if filt.get("ids"):
        wanted = set(filt["ids"])
        semantic = [row for row in semantic if row["id"] in wanted]
        episode = [row for row in episode if row["id"] in wanted]
    for row in semantic: store.db.execute("DELETE FROM semantic_memories WHERE id=?", (row["id"],))
    for row in episode: store.db.execute("DELETE FROM episodic_memories WHERE id=?", (row["id"],))
    return len(semantic) + len(episode)


def clear_memories() -> int:
    count = count_memories()
    store.db.execute("DELETE FROM semantic_memories")
    store.db.execute("DELETE FROM episodic_memories")
    return count


def migrate_legacy_chroma() -> dict:
    """Best-effort one-time import; Chroma is optional and is never needed after migration."""
    marker = ROOT / ".aira" / "chroma-migration-v1"
    if marker.exists(): return {"migrated": 0, "skipped": True}
    legacy_path = ROOT / ".aira" / "chroma"
    if not legacy_path.exists(): return {"migrated": 0, "skipped": True}
    try:
        import chromadb
    except ImportError:
        log.warning("Legacy Chroma data remains untouched at %s; Chroma is not installed, SQLite memory starts empty", legacy_path)
        return {"migrated": 0, "skipped": True}
    client = chromadb.PersistentClient(path=str(legacy_path))
    migrated = 0
    names = {item.name if hasattr(item, "name") else str(item) for item in client.list_collections()}
    for old_name, table in ((config.chroma_collection, "semantic_memories"), (config.episode_collection, "episodic_memories")):
        if old_name not in names: continue
        collection = client.get_collection(old_name)
        total = collection.count()
        for offset in range(0, total, 250):
            batch = collection.get(limit=250, offset=offset, include=["documents", "metadatas", "embeddings"])
            ids = batch.get("ids") or []
            docs = batch.get("documents") or []
            metas = batch.get("metadatas") or []
            vectors = batch.get("embeddings")
            for index, ident in enumerate(ids):
                if vectors is None or index >= len(vectors) or vectors[index] is None: continue
                meta = metas[index] or {}
                text = docs[index] or ""
                if table == "semantic_memories":
                    save_memory_vector(text, list(vectors[index]), str(meta.get("userId") or ""),
                                       str(meta.get("timestamp") or ""), str(meta.get("sessionKey") or
                                       (f"user:{meta['userId']}" if meta.get("userId") else LEGACY_SESSION_KEY)),
                                       meta, ident)
                else:
                    participants = meta.get("participants", [])
                    if isinstance(participants, str): participants = participants.split(",") if participants else []
                    episode = {"id": ident, "text": text, "session_key": meta.get("sessionKey", LEGACY_SESSION_KEY),
                               "date": meta.get("date", ""), "period": meta.get("period", "night"),
                               "start_time": meta.get("startTime", ""), "end_time": meta.get("endTime", ""),
                               "participants": participants, "created_at": meta.get("createdAt", "")}
                    save_episode_vector(episode, list(vectors[index]))
                migrated += 1
    marker.parent.mkdir(parents=True, exist_ok=True)
    marker.write_text(json.dumps({"migrated": migrated, "completed_at": datetime.now(timezone.utc).isoformat()}) + "\n", encoding="utf-8")
    marker.chmod(0o600)
    log.info("Imported %s legacy Chroma memories into SQLite; old Chroma files were retained", migrated)
    return {"migrated": migrated, "skipped": False}
