import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from aira import pipeline
from aira.store import Store, utc_now


class PipelineTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.store = Store(Path(self.temp.name) / "pipeline.db")
        self.patches = [
            patch.object(pipeline, "store", self.store),
            patch.object(pipeline, "embed", new=AsyncMock(return_value=[0.25, 0.75])),
            patch.object(pipeline, "search_memories_by_vector", return_value=[]),
            patch.object(pipeline, "recall_episodes", new=AsyncMock(return_value=[])),
            patch.object(pipeline, "generate_isla_reply", new=AsyncMock(return_value={
                "text": "สวัสดี", "summary": "", "mood": "ดีใจ",
                "color": 0x123456, "rps": None,
            })),
            patch.object(pipeline, "analyze_turn", new=AsyncMock(return_value={
                "affinity": 10, "is_flirt": False, "approvals": {},
                "image": "", "facts": [], "nicknames": [], "memory": "",
                "warnings": [],
            })),
        ]
        for item in self.patches:
            item.start()

    async def asyncTearDown(self):
        for item in reversed(self.patches):
            item.stop()
        self.store.close()
        self.temp.cleanup()

    async def test_group_turn_updates_only_last_speaker(self):
        result = await pipeline.process_message({
            "user_id": "bob", "user": "Bob",
            "text": "Alice: สวัสดี\nBob: ขอถามหน่อย",
            "timestamp": utc_now(), "session_key": "group:99",
            "speakers": [
                {"user_id": "alice", "user": "Alice"},
                {"user_id": "bob", "user": "Bob"},
            ],
        }, SimpleNamespace(parts=[], summary="", file_names=[]))
        self.assertEqual(result["text"], "สวัสดี")
        self.assertEqual(self.store.get_profile("bob")["xp"], 10)
        self.assertEqual(self.store.get_profile("alice")["xp"], 0)
        messages = self.store.get_history(10, "group:99")
        self.assertEqual([row["role"] for row in messages], ["user", "model"])

    async def test_private_turn_persists_in_private_session(self):
        result = await pipeline.process_message({
            "user_id": "alice", "user": "Alice", "text": "Hi",
            "timestamp": utc_now(), "session_key": "user:alice",
        }, SimpleNamespace(parts=[], summary="", file_names=[]))
        self.assertEqual(result["session_key"], "user:alice")
        self.assertEqual(self.store.count_messages(session_key="user:alice"), 2)


if __name__ == "__main__":
    unittest.main()
