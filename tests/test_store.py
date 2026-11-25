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

    def test_session_keys_and_group_membership(self):
        self.assertEqual(user_session_key("1"), "user:1")
        self.assertEqual(group_session_key("9"), "group:9")
        self.db.join_group("1", "9")
        self.assertEqual(self.db.session_key_for("1", "9"), "group:9")
        self.assertEqual(self.db.session_key_for("2", "9"), "user:2")
        self.db.leave_group("1")
        self.assertEqual(self.db.session_key_for("1", "9"), "user:1")

    def test_history_is_session_scoped(self):
        now = utc_now()
        self.db.save_message("user", "private", now, "user:1", "1", "Alice")
        self.db.save_message("user", "group", now, "group:9", "1", "Alice")
        self.assertEqual([x["text"] for x in self.db.get_history(10, "user:1")], ["private"])
        self.assertEqual([x["text"] for x in self.db.get_history(10, "group:9")], ["group"])

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



if __name__ == "__main__":
    unittest.main()
