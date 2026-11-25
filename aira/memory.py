from __future__ import annotations

import json
import logging
import re
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import chromadb

from .config import config
from .gemini import embed
from .store import store

log = logging.getLogger("aira.memory")
LEGACY_SESSION_KEY = "legacy:unattributed"


def _client():
    if config.chroma_url:
        from urllib.parse import urlparse
        parsed = urlparse(config.chroma_url)
        return chromadb.HttpClient(host=parsed.hostname or "127.0.0.1",
                                   port=parsed.port or (443 if parsed.scheme == "https" else 8000),
                                   ssl=parsed.scheme == "https")
    return chromadb.PersistentClient(path=str(config.chroma_path))


client = _client()


def _collection(name: str):
    return client.get_or_create_collection(name=name, metadata={"hnsw:space": "l2"}, embedding_function=None)


def similarity_of(distance) -> float:
    if distance is None:
        return 1.0
    try:
        return 1 - float(distance) / 2
    except (ValueError, TypeError):
        return 1.0


def _session_where(session_key: str) -> dict:
    return {"sessionKey": session_key}


async def save_memory(text: str, user_id: str, timestamp: str, session_key: str,
                      metadata: dict | None = None, memory_id: str | None = None) -> str:
    vector = await embed(text, "document")
    return save_memory_vector(text, vector, user_id, timestamp, session_key, metadata, memory_id)


def save_memory_vector(text: str, vector: list[float], user_id: str, timestamp: str,
                       session_key: str, metadata: dict | None = None, memory_id: str | None = None) -> str:
    import uuid
    ident = memory_id or str(uuid.uuid4())
    meta = {"userId": user_id, "timestamp": timestamp, "sessionKey": session_key, **(metadata or {})}
    _collection(config.chroma_collection).upsert(ids=[ident], embeddings=[vector], documents=[text], metadatas=[meta])
    return ident


async def search_memories(text: str, session_key: str, limit: int = 8,
                          min_similarity: float | None = None) -> list[dict]:
    if limit <= 0:
        return []
    vector = await embed(text, "query")
    return search_memories_by_vector(vector, session_key, limit, min_similarity)


def search_memories_by_vector(vector: list[float], session_key: str, limit: int = 8,
                              min_similarity: float | None = None) -> list[dict]:
    result = _collection(config.chroma_collection).query(
        query_embeddings=[vector], n_results=limit,
        where=_session_where(session_key),
        include=["documents", "metadatas", "distances"],
    )
    rows = []
    ids = (result.get("ids") or [[]])[0]
    docs = (result.get("documents") or [[]])[0]
    metas = (result.get("metadatas") or [[]])[0]
    distances = (result.get("distances") or [[]])[0]
    for index, ident in enumerate(ids):
        score = similarity_of(distances[index] if index < len(distances) else None)
        if min_similarity is not None and score < min_similarity:
            continue
        rows.append({"id": ident, "text": docs[index] if index < len(docs) else "",
                     "metadata": metas[index] or {}, "timestamp": (metas[index] or {}).get("timestamp", ""),
                     "user_id": (metas[index] or {}).get("userId"),
                     "session_key": (metas[index] or {}).get("sessionKey"), "score": score})
    return rows


async def is_duplicate_memory(vector: list[float], session_key: str) -> dict | None:
    found = search_memories_by_vector(vector, session_key, 1)
    return found[0] if found and found[0]["score"] >= config.memory_dedupe_similarity else None


def _local_parts(timestamp: str) -> tuple[str, int]:
    try:
        dt = datetime.fromisoformat(timestamp.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
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
    # Keep the original TypeScript FNV-1a identifier so existing Chroma episodes are updated in place.
    value = (session_key + "\0" + start_time).encode("utf-16-le")
    hash_value = 2166136261
    for index in range(0, len(value), 2):
        code_unit = value[index] | (value[index + 1] << 8)
        hash_value ^= code_unit
        hash_value = (hash_value * 16777619) & 0xFFFFFFFF
    return "episode-" + format(hash_value, "08x")


def temporal_query(text: str, now: datetime | None = None) -> dict:
    now = (now or datetime.now(timezone.utc)).astimezone(ZoneInfo(config.timezone))
    today = now.strftime("%Y-%m-%d")
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
    if not usable:
        return None
    selected = [usable[-1]]
    gap = config.episode_gap_minutes * 60
    for current in reversed(usable[:-1]):
        first = selected[0]
        d1, d2 = _local_parts(current["timestamp"]), _local_parts(first["timestamp"])
        t1 = datetime.fromisoformat(current["timestamp"].replace("Z", "+00:00"))
        t2 = datetime.fromisoformat(first["timestamp"].replace("Z", "+00:00"))
        if d1[0] != d2[0] or episode_period(current["timestamp"]) != episode_period(first["timestamp"]):
            break
        if (t2 - t1).total_seconds() > gap:
            break
        selected.insert(0, current)
    first, last = selected[0], selected[-1]
    return {
        "id": episode_id(session_key, first["timestamp"]),
        "text": " ".join(item["summary"].strip() for item in selected),
        "session_key": session_key, "date": _local_parts(last["timestamp"])[0],
        "period": episode_period(last["timestamp"]),
        "start_time": first["timestamp"], "end_time": last["timestamp"],
        "participants": list(dict.fromkeys(item.get("user_id") for item in selected if item.get("user_id"))),
        "created_at": datetime.now(timezone.utc).isoformat(),
    }


def save_episode_vector(episode: dict, vector: list[float]) -> None:
    _collection(config.episode_collection).upsert(
        ids=[episode["id"]], embeddings=[vector], documents=[episode["text"]],
        metadatas=[{
            "type": "episodic", "sessionKey": episode["session_key"], "date": episode["date"],
            "period": episode["period"], "startTime": episode["start_time"],
            "endTime": episode["end_time"], "createdAt": episode["created_at"],
            "participants": ",".join(episode.get("participants", [])),
        }],
    )


async def save_episode(episode: dict) -> None:
    save_episode_vector(episode, await embed(episode["text"], "document"))


async def build_recent_episode(session_key: str) -> dict | None:
    history = store.get_history(50, session_key)
    summaries = [{"timestamp": row["timestamp"], "summary": row["summary"], "user_id": row["user_id"]}
                 for row in history if row["role"] == "model" and row.get("summary")]
    return build_episode(summaries, session_key)


async def recall_episodes(vector: list[float], session_key: str, query_text: str) -> list[dict]:
    if config.episode_max_results <= 0:
        return []
    where = {"sessionKey": session_key}
    temporal = temporal_query(query_text)
    if temporal:
        clauses = [where, *[{key: value} for key, value in temporal.items()]]
        where = {"$and": clauses}
    result = _collection(config.episode_collection).query(
        query_embeddings=[vector], n_results=config.episode_max_results, where=where,
        include=["documents", "metadatas", "distances"],
    )
    ids = (result.get("ids") or [[]])[0]
    docs = (result.get("documents") or [[]])[0]
    metas = (result.get("metadatas") or [[]])[0]
    dists = (result.get("distances") or [[]])[0]
    rows = []
    for i, ident in enumerate(ids):
        meta = metas[i] or {}
        score = similarity_of(dists[i] if i < len(dists) else None)
        if score < config.episode_min_similarity:
            continue
        rows.append({
            "id": ident, "text": docs[i] if i < len(docs) else "",
            "session_key": meta.get("sessionKey", session_key), "date": meta.get("date", ""),
            "period": meta.get("period", "night"), "start_time": meta.get("startTime", ""),
            "end_time": meta.get("endTime", ""), "participants": str(meta.get("participants", "")).split(","),
            "created_at": meta.get("createdAt", ""), "score": score,
        })
    return rows


async def migrate_memory_sessions() -> dict[str, int]:
    collection = _collection(config.chroma_collection)
    result = collection.get(include=["metadatas", "embeddings", "documents"])
    ids, metas = result.get("ids", []), result.get("metadatas") or []
    vectors, docs = result.get("embeddings"), result.get("documents") or []
    pending, unattributed = [], 0
    already = 0
    for index, ident in enumerate(ids):
        metadata = metas[index] or {}
        if metadata.get("sessionKey"):
            already += 1
            continue
        user_id = metadata.get("userId")
        if not user_id:
            unattributed += 1
        new_metadata = {**metadata, "sessionKey": f"user:{user_id}" if user_id else LEGACY_SESSION_KEY}
        pending.append((ident, index, new_metadata))
    if not pending:
        return {"backfilled": 0, "unattributed": 0, "already_keyed": already}
    for ident, index, metadata in pending:
        kwargs = {"ids": [ident], "metadatas": [metadata],
                  "documents": [docs[index] if index < len(docs) and docs[index] else ""]}
        if vectors is not None and index < len(vectors) and vectors[index] is not None:
            kwargs["embeddings"] = [vectors[index]]
        collection.upsert(**kwargs)
    return {"backfilled": len(pending), "unattributed": unattributed, "already_keyed": already}


async def ingest_memory_background(text: str, user_id: str, timestamp: str, session_key: str) -> None:
    if not text.strip():
        return
    try:
        vector = await embed(text, "document")
        duplicate = await is_duplicate_memory(vector, session_key)
        if duplicate:
            log.info("Skipped duplicate memory for user %s, score=%.2f", user_id, duplicate["score"])
            return
        save_memory_vector(text, vector, user_id, timestamp, session_key,
                           {"eventTimestamp": timestamp, "createdAt": datetime.now(timezone.utc).isoformat()})
    except Exception:
        log.exception("Memory ingestion failed for user %s", user_id)


async def persist_episode_background(session_key: str) -> None:
    try:
        episode = await build_recent_episode(session_key)
        if episode:
            await save_episode(episode)
    except Exception:
        log.exception("Episode persistence failed for session %s", session_key)


def _episode_rows() -> list[dict]:
    collection = _collection(config.episode_collection)
    result = collection.get(include=["documents", "metadatas"])
    ids = result.get("ids", [])
    docs = result.get("documents", []) or []
    metas = result.get("metadatas", []) or []
    rows = []
    for index, ident in enumerate(ids):
        metadata = metas[index] or {}
        participants = metadata.get("participants", [])
        if isinstance(participants, str):
            try:
                decoded = json.loads(participants)
                participants = decoded if isinstance(decoded, list) else participants.split(",")
            except ValueError:
                participants = participants.split(",")
        if not isinstance(participants, list):
            participants = []
        rows.append({
            "id": ident, "text": docs[index] if index < len(docs) and docs[index] else "",
            "user_id": ",".join(str(item) for item in participants),
            "participants": [str(item) for item in participants],
            "session_key": metadata.get("sessionKey"),
            "timestamp": metadata.get("startTime") or metadata.get("start_time") or metadata.get("timestamp", ""),
            "type": "episodic",
        })
    return rows


def _matches_memory_filter(row: dict, filt: dict) -> bool:
    if filt.get("session_key") and row.get("session_key") != filt["session_key"]:
        return False
    if filt.get("user_id"):
        user_id = str(filt["user_id"])
        participants = row.get("participants", [])
        if row.get("type") == "episodic":
            if user_id not in participants:
                return False
        elif str(row.get("user_id") or "") != user_id:
            return False
    return True


def count_memories(filter: dict | None = None) -> int:
    filt = filter or {}
    semantic = _collection(config.chroma_collection)
    where = _session_where(filt.get("session_key")) if filt.get("session_key") else None
    if filt.get("user_id"):
        semantic_where = {"userId": str(filt["user_id"])}
        where = {"$and": [where, semantic_where]} if where else semantic_where
    if filt.get("ids"):
        matching_semantic = semantic.get(ids=filt["ids"], where=where, include=[])
        semantic_count = len(matching_semantic.get("ids", []))
    elif where:
        semantic_count = len(semantic.get(where=where, include=[]).get("ids", []))
    else:
        semantic_count = int(semantic.count())
    episodes = [row for row in _episode_rows() if _matches_memory_filter(row, filt)]
    if filt.get("ids"):
        wanted = set(filt["ids"])
        episodes = [row for row in episodes if row["id"] in wanted]
    return semantic_count + len(episodes)


def list_memories(filter: dict | None = None) -> list[dict]:
    filt = filter or {}
    clauses = []
    if filt.get("session_key"):
        clauses.append({"sessionKey": filt["session_key"]})
    if filt.get("user_id"):
        clauses.append({"userId": str(filt["user_id"])})
    where = clauses[0] if len(clauses) == 1 else ({"$and": clauses} if clauses else None)
    semantic = _collection(config.chroma_collection).get(
        where=where, ids=filt.get("ids") or None,
        include=["documents", "metadatas"],
    )
    rows = []
    for index, ident in enumerate(semantic.get("ids", [])):
        metadata = (semantic.get("metadatas") or [])[index] or {}
        rows.append({
            "id": ident, "text": (semantic.get("documents") or [])[index] or "",
            "user_id": metadata.get("userId"), "session_key": metadata.get("sessionKey"),
            "timestamp": metadata.get("timestamp", ""), "type": "semantic",
        })
    episodes = [row for row in _episode_rows() if _matches_memory_filter(row, filt)]
    if filt.get("ids"):
        wanted = set(filt["ids"])
        episodes = [row for row in episodes if row["id"] in wanted]
    rows.extend(episodes)
    rows.sort(key=lambda row: str(row.get("timestamp") or ""), reverse=True)
    return rows[:int(filt.get("limit", 20))]


async def search_memories_text(query: str, limit: int = 10, session_key: str | None = None) -> list[dict]:
    vector = await embed(query, "query")
    where = _session_where(session_key) if session_key else None
    result = _collection(config.chroma_collection).query(
        query_embeddings=[vector], n_results=limit, where=where,
        include=["documents", "metadatas", "distances"],
    )
    ids = (result.get("ids") or [[]])[0]
    docs = (result.get("documents") or [[]])[0]
    metas = (result.get("metadatas") or [[]])[0]
    distances = (result.get("distances") or [[]])[0]
    return [{"id": ident, "text": docs[i] or "", "user_id": (metas[i] or {}).get("userId"),
             "session_key": (metas[i] or {}).get("sessionKey"),
             "score": similarity_of(distances[i] if i < len(distances) else None)}
            for i, ident in enumerate(ids)]


def delete_memories(filter: dict | None = None) -> int:
    filt = filter or {}
    if not (filt.get("ids") or filt.get("user_id") or filt.get("session_key")):
        raise ValueError("delete_memories requires an ID, user_id or session_key; use clear_memories() for an explicit full clear")
    semantic_collection = _collection(config.chroma_collection)
    episode_collection = _collection(config.episode_collection)
    semantic_where = _session_where(filt["session_key"]) if filt.get("session_key") else None
    if filt.get("user_id"):
        user_filter = {"userId": str(filt["user_id"])}
        semantic_where = {"$and": [semantic_where, user_filter]} if semantic_where else user_filter
    if filt.get("ids"):
        semantic_before = semantic_collection.get(ids=filt["ids"], where=semantic_where, include=[])
        wanted = set(filt["ids"])
        episode_ids = [row["id"] for row in _episode_rows()
                       if row["id"] in wanted and _matches_memory_filter(row, filt)]
        if semantic_before.get("ids"):
            semantic_collection.delete(ids=semantic_before["ids"])
        if episode_ids:
            episode_collection.delete(ids=episode_ids)
        return len(semantic_before.get("ids", [])) + len(episode_ids)
    semantic_ids = (
        semantic_collection.get(where=semantic_where, include=[]).get("ids", [])
        if semantic_where else semantic_collection.get(include=[]).get("ids", [])
    )
    episode_rows = [row for row in _episode_rows() if _matches_memory_filter(row, filt)]
    if semantic_ids:
        semantic_collection.delete(ids=semantic_ids)
    if episode_rows:
        episode_collection.delete(ids=[row["id"] for row in episode_rows])
    return len(semantic_ids) + len(episode_rows)


def clear_memories() -> int:
    semantic_collection = _collection(config.chroma_collection)
    episode_collection = _collection(config.episode_collection)
    semantic_ids = semantic_collection.get(include=[]).get("ids", [])
    episode_ids = episode_collection.get(include=[]).get("ids", [])
    if semantic_ids:
        semantic_collection.delete(ids=semantic_ids)
    if episode_ids:
        episode_collection.delete(ids=episode_ids)
    return len(semantic_ids) + len(episode_ids)
