from __future__ import annotations

import json
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator

from .config import config
from .relationships import (
    APPROVAL_NAMES, derive_bond, is_bond, is_bond_unlock,
)

MAX_FACTS = 40
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


def is_group_session(key: str) -> bool:
    return key.startswith(GROUP_PREFIX)


def group_channel_of(key: str) -> str | None:
    return key[len(GROUP_PREFIX):] if is_group_session(key) else None


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
            file_name TEXT, summary TEXT, session_key TEXT
        )""")
        message_cols = self._columns("messages")
        for name, ddl in (("summary", "TEXT"), ("session_key", "TEXT")):
            if name not in message_cols:
                self.db.execute(f"ALTER TABLE messages ADD COLUMN {name} {ddl}")
        self.db.execute("CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp)")
        self.db.execute("CREATE INDEX IF NOT EXISTS idx_messages_user_id ON messages(user_id)")
        self.db.execute("CREATE INDEX IF NOT EXISTS idx_messages_session_key ON messages(session_key)")
        self._migrate_message_sessions()

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
            if not self._truthy("AIRA_KEEP_LEGACY_SCHEMA"):
                missing = self.db.execute("""SELECT COUNT(*) FROM relationships
                    WHERE user_id NOT IN (SELECT user_id FROM user_profiles)""").fetchone()[0]
                if not missing:
                    self.db.execute("DROP TABLE relationships")
        self.db.execute("""CREATE TABLE IF NOT EXISTS group_sessions(
            user_id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, joined_at TEXT NOT NULL)""")
        self.db.execute("CREATE INDEX IF NOT EXISTS idx_group_sessions_channel ON group_sessions(channel_id)")
        self.db.execute("""CREATE TABLE IF NOT EXISTS character_relationships(
            character_id TEXT NOT NULL, user_id TEXT NOT NULL, relationship TEXT NOT NULL,
            updated_at TEXT NOT NULL, PRIMARY KEY(character_id,user_id))""")
        self.db.execute("""CREATE TABLE IF NOT EXISTS turn_state_applied(
            session_key TEXT NOT NULL, user_id TEXT NOT NULL, event_timestamp TEXT NOT NULL,
            applied_at TEXT NOT NULL, PRIMARY KEY(session_key,user_id,event_timestamp))""")
        for row in self.db.execute("SELECT user_id,facts_json FROM user_profiles").fetchall():
            normalized = _normalize_facts(row["facts_json"])
            serial = json.dumps(normalized, ensure_ascii=False)
            if serial != (row["facts_json"] or "[]"):
                self.db.execute("UPDATE user_profiles SET facts_json=? WHERE user_id=?", (serial, row["user_id"]))

    @staticmethod
    def _truthy(name: str) -> bool:
        return str(__import__("os").getenv(name, "")).lower() in {"1", "true", "yes", "on"}

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

    def save_message(self, role: str, text: str, timestamp: str, session_key: str,
                     user_id: str | None = None, user_name: str | None = None,
                     file_name: str | None = None, summary: str | None = None) -> int:
        cursor = self.db.execute("""INSERT INTO messages
            (role,user_id,user_name,text,timestamp,file_name,summary,session_key)
            VALUES(?,?,?,?,?,?,?,?)""",
            (role, user_id, user_name, text, timestamp, file_name, summary, session_key))
        return int(cursor.lastrowid)

    def get_history(self, limit: int, session_key: str) -> list[dict]:
        rows = self.db.execute("""SELECT id,role,user_id,user_name,text,summary,timestamp,file_name,session_key
            FROM messages WHERE session_key=? ORDER BY id DESC LIMIT ?""", (session_key, limit)).fetchall()
        return [dict(row) for row in reversed(rows)]

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

    def join_group(self, user_id: str, channel_id: str) -> dict:
        previous = self.db.execute("SELECT * FROM group_sessions WHERE user_id=?", (user_id,)).fetchone()
        if previous and previous["channel_id"] == channel_id:
            return {"status": "already", "current": dict(previous)}
        joined = utc_now()
        self.db.execute("""INSERT INTO group_sessions(user_id,channel_id,joined_at) VALUES(?,?,?)
            ON CONFLICT(user_id) DO UPDATE SET channel_id=excluded.channel_id,joined_at=excluded.joined_at""",
            (user_id, channel_id, joined))
        current = {"user_id": user_id, "channel_id": channel_id, "joined_at": joined}
        return {"status": "moved" if previous else "joined", "current": current,
                **({"previous_channel": previous["channel_id"]} if previous else {})}

    def leave_group(self, user_id: str) -> dict | None:
        row = self.db.execute("SELECT * FROM group_sessions WHERE user_id=?", (user_id,)).fetchone()
        if row:
            self.db.execute("DELETE FROM group_sessions WHERE user_id=?", (user_id,))
            return dict(row)
        return None

    def group_membership(self, user_id: str) -> dict | None:
        row = self.db.execute("SELECT * FROM group_sessions WHERE user_id=?", (user_id,)).fetchone()
        return dict(row) if row else None

    def group_members(self, channel_id: str) -> list[dict]:
        return [dict(row) for row in self.db.execute(
            "SELECT * FROM group_sessions WHERE channel_id=? ORDER BY joined_at", (channel_id,)
        ).fetchall()]

    def session_key_for(self, user_id: str, channel_id: str | None) -> str:
        # Every conversation is scoped to its Discord channel, never to a user's opt-in state.
        return group_session_key(channel_id) if channel_id else user_session_key(user_id)

    def get_character_relationship(self, character_id: str, user_id: str) -> str:
        row = self.db.execute("SELECT relationship FROM character_relationships WHERE character_id=? AND user_id=?",
                              (character_id, user_id)).fetchone()
        return row["relationship"] if row else "ยังไม่เคยสร้างความสัมพันธ์"

    def save_character_relationship(self, character_id: str, user_id: str, relationship: str) -> None:
        relationship = relationship.strip()
        if not relationship or len(relationship) > 1200:
            return
        self.db.execute("""INSERT INTO character_relationships(character_id,user_id,relationship,updated_at)
            VALUES(?,?,?,?) ON CONFLICT(character_id,user_id) DO UPDATE SET
            relationship=excluded.relationship,updated_at=excluded.updated_at""",
            (character_id, user_id, relationship, utc_now()))

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
