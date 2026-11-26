import tempfile
import unittest
from pathlib import Path

from aira.store import Store, user_session_key, group_session_key, utc_now


class StoreTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.db = Store(Path(self.temp.name) / "test.db")

    def tearDown(self):
        self.db.close()
        self.temp.cleanup()

    def test_sessions_are_scoped_to_channel_for_every_user(self):
        self.assertEqual(user_session_key("1"), "user:1")
        self.assertEqual(group_session_key("9"), "group:9")
        self.assertEqual(self.db.session_key_for("1", "9"), "group:9")
        self.assertEqual(self.db.session_key_for("2", "9"), "group:9")
        self.assertEqual(self.db.session_key_for("1", "10"), "group:10")
        self.assertEqual(self.db.session_key_for("1", None), "user:1")

    def test_history_is_session_scoped(self):
        now = utc_now()
        self.db.save_message("user", "private", now, "user:1", "1", "Alice")
        self.db.save_message("user", "group", now, "group:9", "1", "Alice")
        self.assertEqual([x["text"] for x in self.db.get_history(10, "user:1")], ["private"])
        self.assertEqual([x["text"] for x in self.db.get_history(10, "group:9")], ["group"])

    def test_history_cache_tracks_appends_and_budget_slices_recent_turns(self):
        timestamp = utc_now()
        self.db.save_message("user", "first", timestamp, "group:cache", "1", "Alice")
        self.assertEqual([row["text"] for row in self.db.get_history(20, "group:cache")], ["first"])
        self.db.save_message("model", "second", timestamp, "group:cache", None, "Nova", None, None, "nova")
        self.db.save_message("user", "third", timestamp, "group:cache", "1", "Alice")
        rows = self.db.get_history(20, "group:cache")
        self.assertEqual([row["text"] for row in rows], ["first", "second", "third"])
        budgeted = self.db.get_history_by_budget(
            "group:cache", 6, lambda text: len(text), max_messages=20,
        )
        self.assertEqual([row["text"] for row in budgeted], ["third"])

    def test_history_cache_is_invalidated_after_deletion(self):
        timestamp = utc_now()
        self.db.save_message("user", "keep", timestamp, "group:cache", "1", "Alice")
        self.db.get_history(10, "group:cache")
        self.db.save_message("user", "remove", timestamp, "group:cache", "1", "Alice")
        self.assertEqual(self.db.delete_messages(session_key="group:cache", limit=1), 1)
        self.assertEqual([row["text"] for row in self.db.get_history(10, "group:cache")], ["keep"])

    def test_the_idle_wait_survives_a_restart(self):
        self.assertIsNone(self.db.idle_wait("group:9"))
        self.db.set_idle_wait("group:9", 42, "2026-11-26T10:30:00+07:00")
        self.assertEqual(self.db.idle_wait("group:9"),
                         {"deadline": "2026-11-26T10:30:00+07:00", "marker": 42})
        # a new message replaces the wait it was measured from
        self.db.set_idle_wait("group:9", 43, "2026-11-26T11:00:00+07:00")
        self.assertEqual(self.db.idle_wait("group:9"),
                         {"deadline": "2026-11-26T11:00:00+07:00", "marker": 43})

    def test_a_day_beat_only_happens_once(self):
        self.assertFalse(self.db.idle_anchor_done("group:9", "morning", "2026-11-26"))
        self.db.mark_idle_anchor("group:9", "morning", "2026-11-26")
        self.assertTrue(self.db.idle_anchor_done("group:9", "morning", "2026-11-26"))
        self.assertFalse(self.db.idle_anchor_done("group:9", "noon", "2026-11-26"))

    def test_a_placeholder_answer_never_becomes_a_relationship(self):
        self.assertFalse(self.db.save_character_pair_relationship("isla", "rem", "ยังไม่เคยสร้างความสัมพันธ์"))
        self.assertEqual(self.db.get_character_pair_relationship("isla", "rem"), "")
        self.assertFalse(self.db.save_character_relationship("isla", "1", "เหมือนเดิม"))
        self.assertEqual(self.db.get_character_relationship("isla", "1"), "ยังไม่เคยสร้างความสัมพันธ์")

    def test_each_character_keeps_its_own_view_of_the_other(self):
        self.assertTrue(self.db.save_character_pair_relationship("rem", "bocchi", "เอ็นดูที่เธอตื่นเต้นง่าย"))
        self.assertTrue(self.db.save_character_pair_relationship("bocchi", "rem", "พี่เรมใจดีมาก"))
        self.assertEqual(self.db.get_character_pair_relationship("rem", "bocchi"), "เอ็นดูที่เธอตื่นเต้นง่าย")
        self.assertEqual(self.db.get_character_pair_relationship("bocchi", "rem"), "พี่เรมใจดีมาก")
        self.assertEqual(self.db.get_character_pair_relationships("bocchi"), {"rem": "พี่เรมใจดีมาก"})
        self.assertEqual(self.db.get_character_pair_relationship("isla", "rem"), "")

    def test_character_messages_and_directed_character_relationships_are_persisted(self):
        timestamp = utc_now()
        self.db.save_message(
            "model", "Nova speaks", timestamp, "group:9", None, "Nova", None,
            "Nova joined the conversation", "nova",
        )
        row = self.db.get_history(10, "group:9")[0]
        self.assertEqual(row["character_id"], "nova")
        self.assertEqual(row["user_name"], "Nova")
        self.db.save_character_pair_relationship("nova", "isla", "Nova thinks Isla is kind")
        self.db.save_character_pair_relationship("isla", "nova", "Isla finds Nova energetic")
        self.assertEqual(self.db.get_character_pair_relationship("nova", "isla"),
                         "Nova thinks Isla is kind")
        self.assertEqual(self.db.get_character_pair_relationship("isla", "nova"),
                         "Isla finds Nova energetic")
        self.assertEqual(self.db.get_character_pair_relationships("nova"),
                         {"isla": "Nova thinks Isla is kind"})
        self.db.save_character_pair_relationship("nova", "nova", "invalid")
        self.assertEqual(self.db.get_character_pair_relationship("nova", "nova"), "")


    def test_autonomous_continuations_are_persisted_updated_and_deleted(self):
        payload = {"created_at": 1000, "previous": {"character_id": "isla", "next_speaker_id": "rem"}}
        self.db.save_autonomous_continuation("group:9", "9", payload)
        self.assertEqual(self.db.autonomous_continuation_count(), 1)
        payload = {**payload, "channel_id": "9"}
        self.assertEqual(self.db.get_autonomous_continuation("group:9"), payload)
        updated = {**payload, "previous": {"character_id": "rem", "next_speaker_id": "bocchi"}}
        self.db.save_autonomous_continuation("group:9", "9", updated)
        self.assertEqual(self.db.get_autonomous_continuation("group:9"), updated)
        self.assertEqual(len(self.db.list_autonomous_continuations()), 1)
        self.db.delete_autonomous_continuation("group:9")
        self.assertEqual(self.db.autonomous_continuation_count(), 0)


    def test_character_profile_updates_are_idempotent_and_owner_scoped(self):
        timestamp = utc_now()
        facts = [{"text": "Alice ชอบชา", "owner_user_id": "1", "confirmed_by_owner": True},
                 {"text": "Bob ชอบกาแฟ", "owner_user_id": "2", "confirmed_by_owner": True}]
        first = self.db.apply_character_profile_updates(
            "1", "Alice", "isla", facts, ["คนรักชา"], timestamp, "group:9")
        second = self.db.apply_character_profile_updates(
            "1", "Alice", "isla", facts, ["คนรักชา"], timestamp, "group:9")
        profile = self.db.get_profile("1")
        self.assertEqual(first["facts_added"], 1)
        self.assertTrue(second["duplicate"])
        self.assertEqual([item["text"] for item in profile["facts"]], ["Alice ชอบชา"])
        self.assertEqual(profile["nickname"], ["คนรักชา"])
        self.assertEqual(profile["xp"], 0)
        self.assertEqual(profile["bond"], "stranger")

    def test_state_update_is_idempotent_and_owner_scoped(self):
        timestamp = utc_now()
        change = {"user_id": "1", "user_name": "Alice", "affinity": 30,
                  "is_flirt": False, "approvals": {}}
        facts = [{"text": "Alice likes tea", "owner_user_id": "1", "confirmed_by_owner": True}]
        first = self.db.apply_turn_state(change, facts, ["Tea lover"], timestamp, "user:1")
        second = self.db.apply_turn_state(change, facts, ["Tea lover"], timestamp, "user:1")
        self.assertFalse(first["duplicate"])
        self.assertTrue(second["duplicate"])
        profile = self.db.get_profile("1")
        self.assertEqual(profile["xp"], 30)
        self.assertEqual(len(profile["facts"]), 1)
        self.assertEqual(profile["nickname"], ["Tea lover"])

    def test_migrates_legacy_messages_and_relationships(self):
        self.db.close()
        import sqlite3
        legacy_path = Path(self.temp.name) / "legacy.db"
        connection = sqlite3.connect(legacy_path)
        connection.executescript("""
            CREATE TABLE messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                role TEXT NOT NULL, user_id TEXT, user_name TEXT,
                text TEXT NOT NULL, timestamp TEXT NOT NULL, file_name TEXT
            );
            INSERT INTO messages(role,user_id,user_name,text,timestamp)
                VALUES('user','42','Alice','hello','2026-01-01T00:00:00Z');
            INSERT INTO messages(role,user_id,user_name,text,timestamp)
                VALUES('model',NULL,NULL,'hi','2026-01-01T00:00:01Z');
            CREATE TABLE relationships(
                user_id TEXT PRIMARY KEY, user_name TEXT, state TEXT, xp INTEGER
            );
            INSERT INTO relationships(user_id,user_name,state,xp)
                VALUES('42','Alice','friend',150);
        """)
        connection.close()
        self.db = Store(legacy_path)
        self.assertEqual(self.db.get_profile("42")["bond"], "friend")
        self.assertEqual(self.db.get_profile("42")["xp"], 150)
        self.assertEqual(self.db.get_character_relationship("isla", "42"),
                         "เรามีความเป็นเพื่อนและพูดคุยกันได้อย่างสบายใจ")
        self.assertEqual([x["session_key"] for x in self.db.get_history(10, "user:42")],
                         ["user:42", "user:42"])
        tables = {row[0] for row in self.db.db.execute(
            "SELECT name FROM sqlite_master WHERE type='table'"
        )}
        self.assertIn("user_profiles", tables)
        self.assertNotIn("relationships", tables)

    def test_unconfirmed_replacement_does_not_overwrite_fact(self):
        timestamp = utc_now()
        self.db.apply_turn_state(
            {"user_id": "1", "user_name": "Alice", "affinity": 0, "approvals": {}},
            [{"text": "Alice likes tea", "owner_user_id": "1", "confirmed_by_owner": True}],
            [], timestamp, "user:1")
        self.db.apply_turn_state(
            {"user_id": "1", "user_name": "Alice", "affinity": 0, "approvals": {}},
            [{"text": "Alice likes coffee", "owner_user_id": "1", "confirmed_by_owner": False,
              "replaces_fact": "Alice likes tea"}],
            [], utc_now(), "user:1")
        self.assertEqual([f["text"] for f in self.db.get_profile("1")["facts"]], ["Alice likes tea"])
        self.db.apply_turn_state(
            {"user_id": "1", "user_name": "Alice", "affinity": 0, "approvals": {}},
            [{"text": "Bob likes coffee", "owner_user_id": "2", "confirmed_by_owner": True}],
            [], utc_now(), "user:1")
        self.assertEqual([f["text"] for f in self.db.get_profile("1")["facts"]], ["Alice likes tea"])



    def test_history_cache_reports_miss_then_hit(self):
        self.db.save_message("user", "cache telemetry", utc_now(), "group:telemetry", "1", "Alice")
        self.db.get_history(10, "group:telemetry")
        self.db.get_history(10, "group:telemetry")
        stats = self.db.history_cache_stats()
        self.assertEqual(stats["misses"], 1)
        self.assertEqual(stats["hits"], 1)
        self.assertEqual(stats["hitRate"], 0.5)
        self.assertEqual(stats["sessions"], 1)

if __name__ == "__main__":
    unittest.main()
