import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from aira import pipeline
from aira.characters import Character
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

    async def test_isla_prompt_allows_silence_but_requires_direct_mentions(self):
        await pipeline.process_message({
            "user_id": "alice", "user": "Alice", "text": "Hi Isla",
            "timestamp": utc_now(), "session_key": "group:99",
        }, SimpleNamespace(parts=[], summary="", file_names=[]))
        system_context = pipeline.generate_isla_reply.await_args.kwargs["system_context"]
        self.assertIn("สามารถเงียบได้ตามปกติ", system_context)
        self.assertIn("เรียกชื่อ Isla โดยตรง ต้องตอบ", system_context)

    async def test_isla_memory_is_character_scoped(self):
        await pipeline.process_message({
            "user_id": "alice", "user": "Alice", "text": "Hi",
            "timestamp": utc_now(), "session_key": "group:99",
        }, SimpleNamespace(parts=[], summary="", file_names=[]))
        self.assertEqual(pipeline.search_memories_by_vector.call_args.args[1],
                         "group:99:character:isla")
        self.assertEqual(pipeline.recall_episodes.await_args.args[1],
                         "group:99:character:isla")
        model = self.store.get_history(10, "group:99")[-1]
        self.assertEqual(model["character_id"], "isla")

    async def test_secondary_character_has_private_memory_and_is_saved_as_actor(self):
        character = Character("nova", "Nova", ("Nova",), Path("nova.md"))
        self.store.save_message("model", "ฉันเป็นห่วง Alice", utc_now(), "group:99",
                                None, "Isla", None, "Isla เป็นห่วง Alice", "isla")
        generate = AsyncMock(return_value={
            "reply": "ฉันเห็นด้วยกับ Isla", "summary": "Nova เห็นด้วยกับ Isla",
            "memory": "", "relationship": "สนิทกับ Alice",
            "relationships": [{"target_character_id": "isla", "relationship": "Nova trusts Isla"}],
        })
        with patch.object(pipeline, "load_characters", return_value=[
            Character("isla", "Isla", ("Isla",), Path("isla.md")), character,
        ]), patch.object(pipeline, "load_character_prompt", return_value="Nova prompt"), \
             patch.object(pipeline, "_spawn", side_effect=lambda coroutine: coroutine.close()), \
             patch.object(pipeline, "generate_character_reply", new=generate):
            result = await pipeline.process_character_reply({
                "user_id": "alice", "user": "Alice", "text": "Nova, คิดยังไง",
                "timestamp": utc_now(), "session_key": "group:99",
            }, character, SimpleNamespace(parts=[], summary="", file_names=[]))
        self.assertEqual(result["text"], "ฉันเห็นด้วยกับ Isla")
        self.assertIn("Isla: ฉันเป็นห่วง Alice", generate.await_args.args[1])
        self.assertEqual(pipeline.search_memories_by_vector.call_args.args[1],
                         "group:99:character:nova")
        saved = self.store.get_history(10, "group:99")[-1]
        self.assertEqual(saved["character_id"], "nova")
        self.assertEqual(self.store.get_character_relationship("nova", "alice"), "สนิทกับ Alice")
        self.assertEqual(self.store.get_character_pair_relationship("nova", "isla"), "Nova trusts Isla")

    async def test_secondary_character_without_timestamp_does_not_duplicate_current_input(self):
        character = Character("nova", "Nova", ("Nova",), Path("nova.md"))
        generate = AsyncMock(return_value={
            "reply": "ฉันอยู่นี่", "summary": "", "memory": "",
            "relationship": "", "relationships": [],
        })
        with patch.object(pipeline, "load_characters", return_value=[
            Character("isla", "Isla", ("Isla",), Path("isla.md")), character,
        ]), patch.object(pipeline, "load_character_prompt", return_value="Nova prompt"), \
             patch.object(pipeline, "_spawn", side_effect=lambda coroutine: coroutine.close()), \
             patch.object(pipeline, "generate_character_reply", new=generate):
            await pipeline.process_character_reply({
                "user_id": "alice", "user": "Alice", "text": "Hi",
                "session_key": "group:99",
            }, character, SimpleNamespace(parts=[], summary="", file_names=[]))
        context = generate.await_args.args[1]
        self.assertEqual(context.count("ข้อความจาก Alice: Hi"), 1)
        self.assertNotIn("Alice: Hi\nAlice: Hi", context)

    async def test_private_turn_persists_in_private_session(self):
        result = await pipeline.process_message({
            "user_id": "alice", "user": "Alice", "text": "Hi",
            "timestamp": utc_now(), "session_key": "user:alice",
        }, SimpleNamespace(parts=[], summary="", file_names=[]))
        self.assertEqual(result["session_key"], "user:alice")
        self.assertEqual(self.store.count_messages(session_key="user:alice"), 2)


if __name__ == "__main__":
    unittest.main()
