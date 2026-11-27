from __future__ import annotations

import json
import sqlite3
from collections import OrderedDict
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator

from .config import config
from .relationships import (
    APPROVAL_NAMES, derive_bond, is_bond, is_bond_unlock,
)

MAX_FACTS = 40
# A character sometimes echoes the prompt's "no relationship yet" placeholder back
# as its answer; storing it would later look like a real feeling.
RELATIONSHIP_PLACEHOLDERS = {
    "ยังไม่เคยสร้างความสัมพันธ์", "ยังไม่มีข้อมูลความสัมพันธ์", "ไม่มีการเปลี่ยนแปลง",
    "ไม่เปลี่ยนแปลง", "เหมือนเดิม", "ไม่มี", "ไม่ระบุ", "ไม่มีอะไรเปลี่ยน",
}


def real_relationship(value: str | None) -> str:
    """Return the text only when it says something about the relationship."""
    text = str(value or "").strip()
    if not text or len(text) > 1200:
        return ""
    if text.rstrip(" .!") in RELATIONSHIP_PLACEHOLDERS:
        return ""
    return text
MAX_NICKNAMES = 8
USER_PREFIX = "user:"
GROUP_PREFIX = "group:"
LEGACY_SESSION_KEY = "legacy:unattributed"


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def user_session_key(user_id: str) -> str:
    return USER_PREFIX + str(user_id)


def group_session_key(channel_id: str) -> str:
    return GROUP_PREFIX + str(channel_id)


def _json_array(raw: Any) -> list:
    if isinstance(raw, list):
        return raw
    if not isinstance(raw, str):
        return []
    try:
        value = json.loads(raw)
    except (ValueError, TypeError):
        return []
    return value if isinstance(value, list) else []


def _normalize_facts(raw: Any, timestamp: str = "") -> list[dict]:
    result = []
    for item in _json_array(raw):
        if isinstance(item, str):
            text = item.strip()
            if text:
                result.append({"text": text, "timestamp": timestamp, "status": "confirmed"})
        elif isinstance(item, dict):
            text = str(item.get("text") or "").strip()
            if text:
                result.append({
                    "text": text,
                    "timestamp": str(item.get("timestamp") or ""),
                    "status": "historical" if item.get("status") == "historical" else "confirmed",
                })
    return result


class Store:
    def __init__(self, path: Path | str | None = None):
        self.path = Path(path or config.sqlite_path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(self.path, timeout=5, isolation_level=None, check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA busy_timeout=5000")
        self._history_cache: OrderedDict[str, list[dict]] = OrderedDict()
        self._history_cache_capacity = 48
        self._history_cache_rows = 500
        self._history_cache_hits = 0
        self._history_cache_misses = 0
        self._history_cache_evictions = 0
        self._initialize()

    @contextmanager
    def transaction(self, immediate: bool = False) -> Iterator[sqlite3.Connection]:
        self.db.execute("BEGIN IMMEDIATE" if immediate else "BEGIN")
        try:
            yield self.db
            self.db.execute("COMMIT")
        except BaseException:
            self.db.execute("ROLLBACK")
            raise

    def _columns(self, table: str) -> set[str]:
        exists = self.db.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (table,)
        ).fetchone()
        return {row["name"] for row in self.db.execute(f"PRAGMA table_info({table})")} if exists else set()

    def _initialize(self) -> None:
        self.db.execute("""CREATE TABLE IF NOT EXISTS messages(
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            role TEXT NOT NULL CHECK(role IN ('user','model')),
            user_id TEXT, user_name TEXT, text TEXT NOT NULL, timestamp TEXT NOT NULL,
            file_name TEXT, summary TEXT, session_key TEXT, character_id TEXT
        )""")
        message_cols = self._columns("messages")
        for name, ddl in (("summary", "TEXT"), ("session_key", "TEXT"), ("character_id", "TEXT"),
                          ("discord_message_id", "TEXT"), ("reply_to_message_id", "TEXT"),
                          ("media_summary", "TEXT")):
            if name not in message_cols:
                self.db.execute(f"ALTER TABLE messages ADD COLUMN {name} {ddl}")
        self.db.executescript("""
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
                start_time TEXT NOT NULL, end_time TEXT NOT NULL,
                participants_json TEXT NOT NULL, created_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_episodes_session ON episodic_memories(session_key);
            CREATE INDEX IF NOT EXISTS idx_episodes_date ON episodic_memories(date, period);
        """)
        # The wait before the room may start talking again lives in the database so a
        # restart resumes the same silence instead of starting a fresh one.
        # The wait before the room may speak again lives in the database, tied to the
        # message it was measured from, so a restart resumes the very same silence.
        self.db.execute("""CREATE TABLE IF NOT EXISTS idle_state(
            session_key TEXT PRIMARY KEY,
            next_open_at TEXT NOT NULL,
            last_message_id INTEGER NOT NULL DEFAULT 0
        )""")
        if "last_message_id" not in self._columns("idle_state"):
            self.db.execute(
                "ALTER TABLE idle_state ADD COLUMN last_message_id INTEGER NOT NULL DEFAULT 0")
        # Material the cast already used for an opening, so the next one starts from
        # something it has never drawn on.
        self.db.execute("""CREATE TABLE IF NOT EXISTS idle_material(
            session_key TEXT NOT NULL,
            kind TEXT NOT NULL,
            ref TEXT NOT NULL,
            used_at TEXT NOT NULL,
            PRIMARY KEY(session_key, kind, ref)
        )""")
        self.db.execute("""CREATE TABLE IF NOT EXISTS idle_anchor_state(
            session_key TEXT NOT NULL, anchor TEXT NOT NULL, day TEXT NOT NULL,
            PRIMARY KEY(session_key, anchor, day)
        )""")
        self.db.execute("CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp)")
        self.db.execute("CREATE INDEX IF NOT EXISTS idx_messages_user_id ON messages(user_id)")
        self.db.execute("CREATE INDEX IF NOT EXISTS idx_messages_session_key ON messages(session_key)")
        self._migrate_message_sessions()
        self.db.execute("UPDATE messages SET character_id='isla' WHERE role='model' AND (user_name IS NULL OR user_name='') AND character_id IS NULL")

        desired = {
            "user_id": "TEXT",
            "user_name": "TEXT NOT NULL DEFAULT ''",
            "nickname_json": "TEXT NOT NULL DEFAULT '[]'",
            "bond": "TEXT NOT NULL DEFAULT 'stranger'",
            "xp": "INTEGER NOT NULL DEFAULT 0",
            "flirt_count": "INTEGER NOT NULL DEFAULT 0",
            "approved_lover": "INTEGER NOT NULL DEFAULT 0",
            "approved_soulmate": "INTEGER NOT NULL DEFAULT 0",
            "approved_sibling": "INTEGER NOT NULL DEFAULT 0",
            "approved_family": "INTEGER NOT NULL DEFAULT 0",
            "facts_json": "TEXT NOT NULL DEFAULT '[]'",
        }
        if not self._columns("user_profiles"):
            self.db.execute("""CREATE TABLE user_profiles(
                user_id TEXT PRIMARY KEY, user_name TEXT NOT NULL DEFAULT '',
                nickname_json TEXT NOT NULL DEFAULT '[]', bond TEXT NOT NULL DEFAULT 'stranger',
                xp INTEGER NOT NULL DEFAULT 0, flirt_count INTEGER NOT NULL DEFAULT 0,
                approved_lover INTEGER NOT NULL DEFAULT 0, approved_soulmate INTEGER NOT NULL DEFAULT 0,
                approved_sibling INTEGER NOT NULL DEFAULT 0, approved_family INTEGER NOT NULL DEFAULT 0,
                facts_json TEXT NOT NULL DEFAULT '[]'
            )""")
        else:
            columns = self._columns("user_profiles")
            for name, ddl in desired.items():
                if name not in columns:
                    add_ddl = "TEXT" if name == "user_id" else ddl
                    self.db.execute(f"ALTER TABLE user_profiles ADD COLUMN {name} {add_ddl}")
            columns = self._columns("user_profiles")
            if "name" in columns:
                self.db.execute("UPDATE user_profiles SET user_name=name WHERE (user_name='' OR user_name IS NULL) AND name IS NOT NULL")
            if "nicknames_json" in columns:
                self.db.execute("UPDATE user_profiles SET nickname_json=nicknames_json WHERE nickname_json='[]' AND nicknames_json IS NOT NULL AND nicknames_json<>'[]'")
        if self._columns("relationships"):
            rel_cols = self._columns("relationships")
            name_col = "user_name" if "user_name" in rel_cols else "''"
            state_col = "state" if "state" in rel_cols else "'stranger'"
            xp_col = "xp" if "xp" in rel_cols else "0"
            rows = self.db.execute(
                f"SELECT user_id,{name_col} AS user_name,{state_col} AS state,{xp_col} AS xp FROM relationships"
            ).fetchall()
            for row in rows:
                bond = row["state"] if is_bond(row["state"]) else "stranger"
                self.db.execute("""INSERT INTO user_profiles(user_id,user_name,bond,xp)
                    VALUES(?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET
                    user_name=CASE WHEN user_profiles.user_name='' THEN excluded.user_name ELSE user_profiles.user_name END,
                    bond=CASE WHEN user_profiles.bond='stranger' THEN excluded.bond ELSE user_profiles.bond END,
                    xp=CASE WHEN user_profiles.xp=0 THEN excluded.xp ELSE user_profiles.xp END""",
                    (row["user_id"], row["user_name"] or row["user_id"], bond, int(row["xp"] or 0)))
            missing = self.db.execute("""SELECT COUNT(*) FROM relationships
                WHERE user_id NOT IN (SELECT user_id FROM user_profiles)""").fetchone()[0]
            if not missing:
                self.db.execute("DROP TABLE relationships")
        self.db.execute("""CREATE TABLE IF NOT EXISTS character_relationships(
            character_id TEXT NOT NULL, user_id TEXT NOT NULL, relationship TEXT NOT NULL,
            updated_at TEXT NOT NULL, PRIMARY KEY(character_id,user_id))""")
        self.db.execute("""CREATE TABLE IF NOT EXISTS character_pair_relationships(
            character_id TEXT NOT NULL, target_character_id TEXT NOT NULL, relationship TEXT NOT NULL,
            updated_at TEXT NOT NULL, PRIMARY KEY(character_id,target_character_id),
            CHECK(character_id<>target_character_id))""")
        # Convert Isla's former numeric bond state into a plain-language relationship
        # only when no narrative relationship has already been recorded.
        legacy_descriptions = {
            "stranger": "เราเพิ่งเริ่มรู้จักกัน ยังอยู่ในช่วงทำความรู้จัก",
            "acquaintance": "เราเริ่มคุ้นเคยกันในฐานะคนรู้จัก",
            "friend": "เรามีความเป็นเพื่อนและพูดคุยกันได้อย่างสบายใจ",
            "close_friend": "เราสนิทและไว้ใจกันมากขึ้น",
            "crush": "มีความรู้สึกพิเศษและความสนใจเชิงโรแมนติกที่กำลังก่อตัว",
            "lover": "เราเคยตกลงคบหากันในฐานะคนรัก",
            "soulmate": "เรามีความผูกพันลึกซึ้งและเคยตกลงเป็นคู่ชีวิต",
            "enemy": "เราเคยมีความขัดแย้งและความไม่ไว้วางใจกัน",
            "sibling": "เราเคยตกลงผูกพันกันแบบพี่น้อง",
            "family": "เราเคยตกลงผูกพันกันแบบครอบครัว",
        }
        for row in self.db.execute("SELECT user_id,bond,xp FROM user_profiles").fetchall():
            if self.db.execute("SELECT 1 FROM character_relationships WHERE character_id='isla' AND user_id=?",
                               (row["user_id"],)).fetchone():
                continue
            bond = row["bond"] if row["bond"] in legacy_descriptions else "stranger"
            if bond == "stranger" and int(row["xp"] or 0) == 0:
                continue
            self.db.execute("INSERT INTO character_relationships(character_id,user_id,relationship,updated_at) VALUES('isla',?,?,?)",
                            (row["user_id"], legacy_descriptions[bond], utc_now()))
        self.db.execute("""CREATE TABLE IF NOT EXISTS autonomous_continuations(
            session_key TEXT PRIMARY KEY, channel_id TEXT NOT NULL, payload_json TEXT NOT NULL,
            updated_at TEXT NOT NULL)""")
        self.db.execute("""CREATE TABLE IF NOT EXISTS turn_state_applied(
            session_key TEXT NOT NULL, user_id TEXT NOT NULL, event_timestamp TEXT NOT NULL,
            applied_at TEXT NOT NULL, PRIMARY KEY(session_key,user_id,event_timestamp))""")
        self.db.execute("""CREATE TABLE IF NOT EXISTS character_profile_updates(
            session_key TEXT NOT NULL, user_id TEXT NOT NULL, character_id TEXT NOT NULL,
            event_timestamp TEXT NOT NULL, applied_at TEXT NOT NULL,
            PRIMARY KEY(session_key,user_id,character_id,event_timestamp))""")
        for row in self.db.execute("SELECT user_id,facts_json FROM user_profiles").fetchall():
            normalized = _normalize_facts(row["facts_json"])
            serial = json.dumps(normalized, ensure_ascii=False)
            if serial != (row["facts_json"] or "[]"):
                self.db.execute("UPDATE user_profiles SET facts_json=? WHERE user_id=?", (serial, row["user_id"]))

    def _migrate_message_sessions(self) -> dict[str, int]:
        rows = self.db.execute(
            "SELECT id,role,user_id FROM messages WHERE session_key IS NULL ORDER BY id"
        ).fetchall()
        if not rows:
            count = self.db.execute("SELECT COUNT(*) FROM messages WHERE session_key IS NOT NULL").fetchone()[0]
            return {"backfilled": 0, "unattributed": 0, "already_keyed": count}
        owner = None
        unattributed = 0
        with self.transaction(immediate=True):
            for row in rows:
                if row["role"] == "user" and row["user_id"]:
                    owner = row["user_id"]
                if row["role"] == "user" and row["user_id"]:
                    key = user_session_key(row["user_id"])
                elif owner:
                    key = user_session_key(owner)
                else:
                    key = LEGACY_SESSION_KEY
                    unattributed += 1
                self.db.execute("UPDATE messages SET session_key=? WHERE id=?", (key, row["id"]))
        return {"backfilled": len(rows), "unattributed": unattributed, "already_keyed": 0}

    @staticmethod
    def _profile(row: sqlite3.Row | None) -> dict | None:
        if row is None:
            return None
        bond = row["bond"] if is_bond(row["bond"]) else "stranger"
        approvals = {name: bool(row[f"approved_{name}"]) for name in ("lover", "soulmate", "sibling", "family")}
        nicknames = [str(x).strip() for x in _json_array(row["nickname_json"]) if isinstance(x, str) and str(x).strip()]
        return {
            "user_id": row["user_id"], "user_name": row["user_name"] or row["user_id"],
            "nickname": nicknames, "bond": bond, "xp": int(row["xp"] or 0),
            "flirt_count": int(row["flirt_count"] or 0), "approvals": approvals,
            "facts": _normalize_facts(row["facts_json"]),
        }

    def get_profile(self, user_id: str) -> dict | None:
        row = self.db.execute("SELECT * FROM user_profiles WHERE user_id=?", (user_id,)).fetchone()
        return self._profile(row)

    def get_profiles(self, user_ids: list[str]) -> list[dict]:
        ids = list(dict.fromkeys(x for x in user_ids if x))
        if not ids:
            return []
        marks = ",".join("?" for _ in ids)
        return [self._profile(row) for row in self.db.execute(
            f"SELECT * FROM user_profiles WHERE user_id IN ({marks})", ids
        ).fetchall()]

    def upsert_profile(self, user_id: str, **patch: Any) -> dict | None:
        current = self.get_profile(user_id)
        name = patch.get("user_name", (current or {}).get("user_name", user_id))
        values = {
            "user_name": name,
            "nickname_json": json.dumps(patch.get("nickname", (current or {}).get("nickname", [])), ensure_ascii=False),
            "bond": patch.get("bond", (current or {}).get("bond", "stranger")),
            "xp": int(patch.get("xp", (current or {}).get("xp", 0))),
            "flirt_count": max(0, int(patch.get("flirt_count", (current or {}).get("flirt_count", 0)))),
            "facts_json": json.dumps(patch.get("facts", (current or {}).get("facts", [])), ensure_ascii=False),
        }
        approvals = patch.get("approvals", (current or {}).get("approvals", {}))
        for key in ("lover", "soulmate", "sibling", "family"):
            values[f"approved_{key}"] = int(bool(approvals.get(key, False)))
        cols = ["user_id", *values]
        self.db.execute(
            f"INSERT INTO user_profiles({','.join(cols)}) VALUES({','.join('?' for _ in cols)}) "
            f"ON CONFLICT(user_id) DO UPDATE SET " + ",".join(f"{col}=excluded.{col}" for col in values),
            [user_id, *values.values()],
        )
        return self.get_profile(user_id)

    def apply_character_profile_updates(self, user_id: str, user_name: str, character_id: str,
                                        facts: list[dict], nicknames: list[str],
                                        timestamp: str, session_key: str) -> dict:
        """Persist user-owned facts/nicknames without touching legacy relationship scores."""
        with self.transaction(immediate=True):
            duplicate = self.db.execute("""SELECT 1 FROM character_profile_updates
                WHERE session_key=? AND user_id=? AND character_id=? AND event_timestamp=?""",
                (session_key, user_id, character_id, timestamp)).fetchone()
            current = self.get_profile(user_id) or self.upsert_profile(user_id, user_name=user_name)
            if duplicate:
                return {"profile": current, "duplicate": True, "facts_added": 0, "nicknames_added": 0}

            existing = list((current or {}).get("facts", []))
            by_text = {item["text"].casefold(): item for item in existing}
            replaced: set[str] = set()
            fresh: list[dict] = []
            fresh_keys: set[str] = set()
            for proposal in facts[:3] if isinstance(facts, list) else []:
                if not isinstance(proposal, dict):
                    continue
                text = str(proposal.get("text") or "").strip()[:1000]
                owner = str(proposal.get("owner_user_id") or proposal.get("ownerUserId") or "").strip()
                confirmed = proposal.get("confirmed_by_owner", proposal.get("confirmedByOwner", False)) is True
                if not text or owner != user_id:
                    continue
                replaces = str(proposal.get("replaces_fact") or proposal.get("replacesFact") or "").strip()
                old = by_text.get((replaces or text).casefold())
                if old and old["text"].casefold() != text.casefold():
                    if not confirmed:
                        continue
                    replaced.add(old["text"].casefold())
                elif old:
                    continue
                if text.casefold() not in fresh_keys:
                    fresh_keys.add(text.casefold())
                    fresh.append({"text": text, "timestamp": timestamp, "status": "confirmed"})

            keep = [item for item in existing if item["text"].casefold() not in replaced]
            historical = [{**item, "status": "historical"} for item in existing
                          if item["text"].casefold() in replaced]
            final_facts = (fresh + keep + historical)[:MAX_FACTS]

            old_names = list((current or {}).get("nickname", []))
            seen = {name.casefold() for name in old_names}
            fresh_names = []
            for nickname in nicknames if isinstance(nicknames, list) else []:
                value = str(nickname).strip()[:80]
                if value and value.casefold() not in seen:
                    seen.add(value.casefold())
                    fresh_names.append(value)
            all_names = (fresh_names + old_names)[:MAX_NICKNAMES]
            profile = self.upsert_profile(user_id, user_name=user_name,
                                          facts=final_facts, nickname=all_names)
            self.db.execute("""INSERT INTO character_profile_updates
                (session_key,user_id,character_id,event_timestamp,applied_at) VALUES(?,?,?,?,?)""",
                (session_key, user_id, character_id, timestamp, utc_now()))
        return {"profile": profile, "duplicate": False,
                "facts_added": len(fresh), "nicknames_added": len(fresh_names)}

    def save_message(self, role: str, text: str, timestamp: str, session_key: str,
                     user_id: str | None = None, user_name: str | None = None,
                     file_name: str | None = None, summary: str | None = None,
                     character_id: str | None = None, discord_message_id: str | None = None,
                     reply_to_message_id: str | None = None, media_summary: str | None = None) -> int:
        cursor = self.db.execute("""INSERT INTO messages
            (role,user_id,user_name,text,timestamp,file_name,summary,session_key,character_id,
             discord_message_id,reply_to_message_id,media_summary)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?)""",
            (role, user_id, user_name, text, timestamp, file_name, summary, session_key, character_id,
             discord_message_id, reply_to_message_id, media_summary))
        row = {
            "id": int(cursor.lastrowid), "role": role, "user_id": user_id,
            "user_name": user_name, "text": text, "timestamp": timestamp,
            "file_name": file_name, "summary": summary, "session_key": session_key,
            "character_id": character_id, "discord_message_id": discord_message_id,
            "reply_to_message_id": reply_to_message_id, "media_summary": media_summary,
        }
        cached = self._history_cache.get(session_key)
        if cached is not None:
            cached.append(row)
            if len(cached) > self._history_cache_rows:
                del cached[:-self._history_cache_rows]
            self._history_cache.move_to_end(session_key)
        return int(cursor.lastrowid)

    def recent_styles(self, session_key: str, limit: int = 6) -> list[str]:
        rows = self.db.execute(
            """SELECT ref FROM idle_material WHERE session_key=? AND kind='style'
               ORDER BY used_at DESC LIMIT ?""", (session_key, int(limit))).fetchall()
        return [str(row["ref"]) for row in rows]

    def recent_materials(self, session_key: str, limit: int = 8) -> list[str]:
        rows = self.db.execute(
            """SELECT ref FROM idle_material WHERE session_key=? AND kind='ai'
               ORDER BY used_at DESC LIMIT ?""", (session_key, int(limit))).fetchall()
        return [str(row["ref"]) for row in rows]

    def mark_material(self, session_key: str, kind: str, ref: str) -> None:
        self.db.execute(
            """INSERT OR REPLACE INTO idle_material(session_key,kind,ref,used_at)
               VALUES(?,?,?,?)""", (session_key, kind, ref, utc_now()))

    def recent_styles(self, session_key: str, limit: int = 6) -> list[str]:
        rows = self.db.execute(
            """SELECT ref FROM idle_material WHERE session_key=? AND kind='style'
               ORDER BY used_at DESC LIMIT ?""", (session_key, int(limit))).fetchall()
        return [str(row["ref"]) for row in rows]

    def recent_materials(self, session_key: str, limit: int = 8) -> list[str]:
        rows = self.db.execute(
            """SELECT ref FROM idle_material WHERE session_key=? AND kind='ai'
               ORDER BY used_at DESC LIMIT ?""", (session_key, int(limit))).fetchall()
        return [str(row["ref"]) for row in rows]

    def mark_material(self, session_key: str, kind: str, ref: str) -> None:
        self.db.execute(
            """INSERT OR REPLACE INTO idle_material(session_key,kind,ref,used_at)
               VALUES(?,?,?,?)""", (session_key, kind, ref, utc_now()))

    def unused_memory(self, character_session: str, session_key: str) -> tuple[str, str] | None:
        """A memory this character has never used as an opening, at random."""
        for _ in range(2):
            row = self.db.execute(
                """SELECT id, text FROM semantic_memories
                   WHERE session_key=?
                     AND id NOT IN (SELECT ref FROM idle_material
                                    WHERE session_key=? AND kind='memory')
                   ORDER BY RANDOM() LIMIT 1""",
                (character_session, session_key)).fetchone()
            if row:
                return str(row["id"]), str(row["text"])
            # everything has been used once: forget the marks and start again
            self.db.execute(
                "DELETE FROM idle_material WHERE session_key=? AND kind='memory'", (session_key,))
        return None

    def old_user_line(self, session_key: str, skip_recent: int = 30) -> str:
        """Something a member said long ago, offered as raw material."""
        row = self.db.execute(
            """SELECT text FROM messages
               WHERE session_key=? AND role='user' AND length(trim(text)) > 12
               ORDER BY RANDOM() LIMIT 1""", (session_key,)).fetchone()
        return str(row["text"]) if row else ""

    def mark_material(self, session_key: str, kind: str, ref: str) -> None:
        self.db.execute(
            """INSERT OR REPLACE INTO idle_material(session_key,kind,ref,used_at)
               VALUES(?,?,?,?)""", (session_key, kind, ref, utc_now()))

    def idle_wait(self, session_key: str) -> dict | None:
        row = self.db.execute(
            "SELECT next_open_at, last_message_id FROM idle_state WHERE session_key=?",
            (session_key,)).fetchone()
        if not row:
            return None
        return {"deadline": str(row["next_open_at"]),
                "marker": int(row["last_message_id"] or 0)}

    def set_idle_wait(self, session_key: str, marker: int, when: str) -> None:
        self.db.execute(
            """INSERT INTO idle_state(session_key,next_open_at,last_message_id) VALUES(?,?,?)
               ON CONFLICT(session_key) DO UPDATE SET next_open_at=excluded.next_open_at,
                                                   last_message_id=excluded.last_message_id""",
            (session_key, when, int(marker)))

    def idle_anchor_done(self, session_key: str, anchor: str, day: str) -> bool:
        """Has this moment of the day already produced a conversation?"""
        row = self.db.execute(
            "SELECT 1 FROM idle_anchor_state WHERE session_key=? AND anchor=? AND day=?",
            (session_key, anchor, day),
        ).fetchone()
        return bool(row)

    def mark_idle_anchor(self, session_key: str, anchor: str, day: str) -> None:
        self.db.execute(
            "INSERT OR REPLACE INTO idle_anchor_state(session_key,anchor,day) VALUES(?,?,?)",
            (session_key, anchor, day),
        )
        self.db.execute("DELETE FROM idle_anchor_state WHERE day<?", (day,))

    def set_discord_message_id(self, row_id: int, discord_message_id: str) -> None:
        """Attach the Discord id of a sent character card so replies to it can be linked."""
        self.db.execute("UPDATE messages SET discord_message_id=? WHERE id=?",
                        (str(discord_message_id), int(row_id)))
        for cached in self._history_cache.values():
            for row in cached:
                if row.get("id") == int(row_id):
                    row["discord_message_id"] = str(discord_message_id)
                    return

    def get_history(self, limit: int, session_key: str) -> list[dict]:
        cached = self._history_cache.get(session_key)
        if cached is None:
            self._history_cache_misses += 1
            rows = self.db.execute("""SELECT id,role,user_id,user_name,text,summary,timestamp,file_name,
                session_key,character_id,discord_message_id,reply_to_message_id,media_summary
                FROM messages WHERE session_key=? ORDER BY id DESC LIMIT ?""",
                (session_key, self._history_cache_rows)).fetchall()
            cached = [dict(row) for row in reversed(rows)]
            self._history_cache[session_key] = cached
            if len(self._history_cache) > self._history_cache_capacity:
                self._history_cache.popitem(last=False)
                self._history_cache_evictions += 1
        else:
            self._history_cache_hits += 1
            self._history_cache.move_to_end(session_key)
        selected = cached[-max(0, int(limit)):] if limit else []
        return [dict(row) for row in selected]

    def get_history_by_budget(self, session_key: str, token_budget: int,
                              estimate_tokens, max_messages: int = 500) -> list[dict]:
        budget = max(0, int(token_budget))
        if budget <= 0:
            return []
        rows = self.get_history(max_messages, session_key)
        selected = []
        used = 0
        for row in reversed(rows):
            text = " ".join(str(row[key]) for key in ("text", "summary", "media_summary")
                            if row.get(key))
            cost = max(1, int(estimate_tokens(text)))
            if used + cost > budget:
                break
            selected.append(row)
            used += cost
        selected.reverse()
        return selected

    def history_cache_stats(self) -> dict:
        requests = self._history_cache_hits + self._history_cache_misses
        return {
            "hits": self._history_cache_hits,
            "misses": self._history_cache_misses,
            "evictions": self._history_cache_evictions,
            "hitRate": round(self._history_cache_hits / requests, 4) if requests else 0.0,
            "sessions": len(self._history_cache),
            "sessionCapacity": self._history_cache_capacity,
            "cachedMessages": sum(len(rows) for rows in self._history_cache.values()),
            "maxMessagesPerSession": self._history_cache_rows,
        }

    def _invalidate_history_cache(self) -> None:
        self._history_cache.clear()

    @staticmethod
    def _message_where(filters: dict | None = None) -> tuple[str, list]:
        filters = filters or {}
        clauses, args = [], []
        for key, column in (("user_id", "user_id"), ("session_key", "session_key"), ("role", "role")):
            value = filters.get(key)
            if value:
                clauses.append(f"{column}=?")
                args.append(value)
        if filters.get("before"):
            clauses.append("timestamp<?")
            args.append(filters["before"])
        if filters.get("after"):
            clauses.append("timestamp>=?")
            args.append(filters["after"])
        ids = filters.get("ids") or []
        if ids:
            clauses.append("id IN (" + ",".join("?" for _ in ids) + ")")
            args.extend(ids)
        return (" WHERE " + " AND ".join(clauses) if clauses else "", args)

    def count_filtered_messages(self, filters: dict | None = None) -> int:
        where, args = self._message_where(filters)
        return int(self.db.execute("SELECT COUNT(*) FROM messages" + where, args).fetchone()[0])

    def list_messages(self, filters: dict | None = None, limit: int = 20) -> list[dict]:
        where, args = self._message_where(filters)
        rows = self.db.execute("SELECT * FROM messages" + where + " ORDER BY id DESC LIMIT ?", [*args, limit]).fetchall()
        return [dict(row) for row in rows]

    def delete_filtered_messages(self, filters: dict | None = None, limit: int | None = None) -> int:
        self._invalidate_history_cache()
        where, args = self._message_where(filters)
        if not where:
            raise ValueError("Refusing to delete all messages without an explicit all operation")
        if limit is not None:
            sql = "DELETE FROM messages WHERE id IN (SELECT id FROM messages" + where + " ORDER BY id DESC LIMIT ?)"
            args.append(limit)
        else:
            sql = "DELETE FROM messages" + where
        return self.db.execute(sql, args).rowcount

    def count_messages(self, user_id: str | None = None, session_key: str | None = None) -> int:
        where, args = [], []
        if user_id:
            where.append("user_id=?"); args.append(user_id)
        if session_key:
            where.append("session_key=?"); args.append(session_key)
        sql = "SELECT COUNT(*) FROM messages" + (" WHERE " + " AND ".join(where) if where else "")
        return int(self.db.execute(sql, args).fetchone()[0])

    def delete_messages(self, user_id: str | None = None, session_key: str | None = None,
                        limit: int | None = None, delete_all: bool = False) -> int:
        self._invalidate_history_cache()
        where, args = [], []
        if user_id: where.append("user_id=?"); args.append(user_id)
        if session_key: where.append("session_key=?"); args.append(session_key)
        if not where and not delete_all:
            raise ValueError("Refusing to delete all messages without delete_all=True")
        if limit is not None:
            sql = "DELETE FROM messages WHERE id IN (SELECT id FROM messages"
            if where: sql += " WHERE " + " AND ".join(where)
            sql += " ORDER BY id DESC LIMIT ?)"
            args.append(limit)
        else:
            sql = "DELETE FROM messages" + (" WHERE " + " AND ".join(where) if where else "")
        cur = self.db.execute(sql, args)
        return cur.rowcount

    def session_key_for(self, user_id: str, channel_id: str | None) -> str:
        # Every conversation is scoped to its Discord channel, never to a user's opt-in state.
        return group_session_key(channel_id) if channel_id else user_session_key(user_id)

    def save_autonomous_continuation(self, session_key: str, channel_id: str, payload: dict) -> None:
        # Keep the routing ID in both indexed form and payload so workers can
        # resume from get_autonomous_continuation() without a second DB lookup.
        payload = {**payload, "channel_id": str(channel_id)}
        encoded = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
        self.db.execute("""INSERT INTO autonomous_continuations(session_key,channel_id,payload_json,updated_at)
            VALUES(?,?,?,?) ON CONFLICT(session_key) DO UPDATE SET
            channel_id=excluded.channel_id,payload_json=excluded.payload_json,updated_at=excluded.updated_at""",
            (session_key, str(channel_id), encoded, utc_now()))

    def get_autonomous_continuation(self, session_key: str) -> dict | None:
        row = self.db.execute("SELECT payload_json FROM autonomous_continuations WHERE session_key=?",
                              (session_key,)).fetchone()
        if not row:
            return None
        try:
            value = json.loads(row["payload_json"])
            return value if isinstance(value, dict) else None
        except (ValueError, TypeError):
            return None

    def list_autonomous_continuations(self) -> list[tuple[str, str, dict]]:
        rows = self.db.execute("SELECT session_key,channel_id,payload_json FROM autonomous_continuations").fetchall()
        result = []
        for row in rows:
            try:
                payload = json.loads(row["payload_json"])
            except (ValueError, TypeError):
                self.delete_autonomous_continuation(row["session_key"])
                continue
            if isinstance(payload, dict):
                result.append((row["session_key"], row["channel_id"], payload))
        return result

    def delete_autonomous_continuation(self, session_key: str) -> None:
        self.db.execute("DELETE FROM autonomous_continuations WHERE session_key=?", (session_key,))

    def autonomous_continuation_count(self) -> int:
        return int(self.db.execute("SELECT COUNT(*) FROM autonomous_continuations").fetchone()[0])

    def get_character_relationship(self, character_id: str, user_id: str) -> str:
        row = self.db.execute("SELECT relationship FROM character_relationships WHERE character_id=? AND user_id=?",
                              (character_id, user_id)).fetchone()
        return row["relationship"] if row else "ยังไม่เคยสร้างความสัมพันธ์"

    def save_character_relationship(self, character_id: str, user_id: str, relationship: str) -> bool:
        relationship = real_relationship(relationship)
        if not relationship:
            return False
        self.db.execute("""INSERT INTO character_relationships(character_id,user_id,relationship,updated_at)
            VALUES(?,?,?,?) ON CONFLICT(character_id,user_id) DO UPDATE SET
            relationship=excluded.relationship,updated_at=excluded.updated_at""",
            (character_id, user_id, relationship, utc_now()))
        return True

    def get_character_pair_relationship(self, character_id: str, target_character_id: str) -> str:
        row = self.db.execute(
            "SELECT relationship FROM character_pair_relationships WHERE character_id=? AND target_character_id=?",
            (character_id, target_character_id),
        ).fetchone()
        return real_relationship(row["relationship"]) if row else ""

    def get_character_pair_relationships(self, character_id: str) -> dict[str, str]:
        rows = self.db.execute(
            "SELECT target_character_id,relationship FROM character_pair_relationships WHERE character_id=?",
            (character_id,),
        ).fetchall()
        return {row["target_character_id"]: real_relationship(row["relationship"])
                for row in rows if real_relationship(row["relationship"])}

    def save_character_pair_relationship(self, character_id: str, target_character_id: str,
                                         relationship: str) -> bool:
        relationship = real_relationship(relationship)
        if character_id == target_character_id or not relationship:
            return False
        self.db.execute("""INSERT INTO character_pair_relationships(
            character_id,target_character_id,relationship,updated_at) VALUES(?,?,?,?)
            ON CONFLICT(character_id,target_character_id) DO UPDATE SET
            relationship=excluded.relationship,updated_at=excluded.updated_at""",
            (character_id, target_character_id, relationship, utc_now()))
        return True

    def apply_turn_state(self, change: dict, facts: list[dict], nicknames: list[str],
                         timestamp: str, session_key: str) -> dict:
        user_id = change["user_id"]
        with self.transaction(immediate=True):
            existing = self.db.execute("""SELECT 1 FROM turn_state_applied
                WHERE session_key=? AND user_id=? AND event_timestamp=?""",
                (session_key, user_id, timestamp)).fetchone()
            if existing:
                profile = self.get_profile(user_id)
                bond = (profile or {}).get("bond", "stranger")
                return {"profile": profile, "before": bond, "after": bond,
                        "xp": (profile or {}).get("xp", 0), "flirt_count": (profile or {}).get("flirt_count", 0),
                        "flirt_delta": 0, "bond_unlocked": False, "facts_added": 0,
                        "nicknames_added": 0, "duplicate": True}
            row = self.db.execute("SELECT * FROM user_profiles WHERE user_id=?", (user_id,)).fetchone()
            current = self._profile(row)
            before = (current or {}).get("bond", "stranger")
            xp = (current or {}).get("xp", 0) + int(change.get("affinity") or 0)
            flirted = change.get("is_flirt") is True
            flirt_count = (current or {}).get("flirt_count", 0) + int(flirted)
            approvals = dict((current or {}).get("approvals", {}))
            for key in APPROVAL_NAMES:
                if change.get("approvals", {}).get(key):
                    approvals[key] = True
            derivation = derive_bond(before, xp, flirt_count, approvals)
            for key in derivation.consumed:
                approvals[key] = False

            old_facts = (current or {}).get("facts", [])
            current_facts = [fact for fact in old_facts if fact.get("status") != "historical"]
            historical = [fact for fact in old_facts if fact.get("status") == "historical"]
            by_text = {fact["text"].casefold(): fact for fact in current_facts}
            replaced: set[str] = set()
            fresh: list[dict] = []
            fresh_keys: set[str] = set()
            for proposal in facts:
                text = str(proposal.get("text") or "").strip()
                owner = str(proposal.get("owner_user_id") or proposal.get("ownerUserId") or "").strip()
                confirmed = proposal.get("confirmed_by_owner", proposal.get("confirmedByOwner", False)) is True
                if not text or owner != user_id:
                    continue
                replaces = str(proposal.get("replaces_fact") or proposal.get("replacesFact") or "").strip()
                old = by_text.get((replaces or text).casefold())
                if old and old["text"].casefold() != text.casefold():
                    if not confirmed:
                        continue
                    replaced.add(old["text"].casefold())
                elif old:
                    continue
                if text.casefold() in fresh_keys:
                    continue
                fresh_keys.add(text.casefold())
                fresh.append({"text": text, "timestamp": timestamp, "status": "confirmed"})
            next_current = [fact for fact in current_facts if fact["text"].casefold() not in replaced]
            replaced_historical = [{**fact, "status": "historical"} for fact in current_facts if fact["text"].casefold() in replaced]
            final_facts = (fresh + next_current + replaced_historical + historical)[:MAX_FACTS]

            old_names = (current or {}).get("nickname", [])
            seen_names = {name.casefold() for name in old_names}
            fresh_names = []
            for name in nicknames:
                value = str(name).strip()
                if value and value.casefold() not in seen_names:
                    seen_names.add(value.casefold())
                    fresh_names.append(value)
            all_names = (fresh_names + old_names)[:MAX_NICKNAMES]
            name = change.get("user_name") or (current or {}).get("user_name") or user_id
            values = {
                "user_name": name, "bond": derivation.bond, "xp": xp, "flirt_count": flirt_count,
                "approved_lover": int(approvals.get("lover", False)),
                "approved_soulmate": int(approvals.get("soulmate", False)),
                "approved_sibling": int(approvals.get("sibling", False)),
                "approved_family": int(approvals.get("family", False)),
                "facts_json": json.dumps(final_facts, ensure_ascii=False),
                "nickname_json": json.dumps(all_names, ensure_ascii=False),
            }
            self.db.execute("""INSERT INTO user_profiles(user_id,user_name,bond,xp,flirt_count,
                approved_lover,approved_soulmate,approved_sibling,approved_family,facts_json,nickname_json)
                VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET
                user_name=excluded.user_name,bond=excluded.bond,xp=excluded.xp,flirt_count=excluded.flirt_count,
                approved_lover=excluded.approved_lover,approved_soulmate=excluded.approved_soulmate,
                approved_sibling=excluded.approved_sibling,approved_family=excluded.approved_family,
                facts_json=excluded.facts_json,nickname_json=excluded.nickname_json""",
                (user_id, values["user_name"], values["bond"], values["xp"], values["flirt_count"],
                 values["approved_lover"], values["approved_soulmate"], values["approved_sibling"],
                 values["approved_family"], values["facts_json"], values["nickname_json"]))
            self.db.execute("INSERT INTO turn_state_applied(session_key,user_id,event_timestamp,applied_at) VALUES(?,?,?,?)",
                            (session_key, user_id, timestamp, utc_now()))
            profile = self.get_profile(user_id)
        return {"profile": profile, "before": before, "after": derivation.bond, "xp": xp,
                "flirt_count": flirt_count, "flirt_delta": int(flirted),
                "bond_unlocked": is_bond_unlock(before, derivation.bond),
                "facts_added": len(fresh), "nicknames_added": len(fresh_names),
                "duplicate": False}

    def list_profiles(self, limit: int = 100) -> list[dict]:
        rows = self.db.execute("SELECT * FROM user_profiles ORDER BY xp DESC,user_name ASC LIMIT ?", (limit,)).fetchall()
        return [self._profile(row) for row in rows]

    def close(self) -> None:
        self.db.close()


store = Store()
