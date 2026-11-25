import asyncio
import tempfile
import unittest

import chromadb

from aira import memory
from aira.config import config


class MemoryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.old_client = memory.client
        self.old_collection = config.chroma_collection
        self.old_episode_collection = config.episode_collection
        memory.client = chromadb.PersistentClient(path=self.temp.name)
        config.chroma_collection = "test_memories"
        config.episode_collection = "test_episodes"

    def tearDown(self):
        memory.client = self.old_client
        config.chroma_collection = self.old_collection
        config.episode_collection = self.old_episode_collection
        self.temp.cleanup()

    def test_semantic_memory_is_session_scoped(self):
        memory.save_memory_vector("Alice likes tea", [1.0, 0.0, 0.0], "1", "2026-11-25T00:00:00Z", "user:1")
        memory.save_memory_vector("Bob likes coffee", [0.0, 1.0, 0.0], "2", "2026-11-25T00:00:00Z", "user:2")
        self.assertEqual(memory.count_memories({"session_key": "user:1"}), 1)
        rows = memory.search_memories_by_vector([1.0, 0.0, 0.0], "user:1", 5, 0.5)
        self.assertEqual([row["text"] for row in rows], ["Alice likes tea"])

    def test_memory_crud(self):
        ident = memory.save_memory_vector("Tea", [1.0, 0.0, 0.0], "1", "2026-11-25T00:00:00Z", "user:1")
        self.assertEqual(len(memory.list_memories({"user_id": "1", "ids": []})), 1)
        self.assertEqual(len(memory.list_memories({"user_id": "1"})), 1)
        self.assertEqual(memory.delete_memories({"ids": [ident]}), 1)
        memory.save_memory_vector("Coffee", [0.0, 1.0, 0.0], "2", "2026-11-25T00:00:00Z", "user:2")
        self.assertEqual(memory.clear_memories(), 1)
        self.assertEqual(memory.count_memories(), 0)

    def test_legacy_records_are_assigned_a_session(self):
        collection = memory._collection(config.chroma_collection)
        collection.add(ids=["legacy"], embeddings=[[1.0, 0.0, 0.0]],
                       documents=["Legacy memory"], metadatas=[{"userId": "42"}])
        result = asyncio.run(memory.migrate_memory_sessions())
        self.assertEqual(result["backfilled"], 1)
        rows = memory.list_memories({"session_key": "user:42"})
        self.assertEqual([row["text"] for row in rows], ["Legacy memory"])

    def test_delete_requires_a_scope_and_does_not_cross_user_boundaries(self):
        first = {"id": "episode-user-1", "text": "Alice event", "session_key": "user:1",
                 "date": "2026-11-25", "period": "night", "start_time": "2026-11-25T00:00:00Z",
                 "end_time": "2026-11-25T00:00:00Z", "participants": ["1"],
                 "created_at": "2026-11-25T00:00:00Z"}
        second = {**first, "id": "episode-user-2", "text": "Bob event", "session_key": "user:2",
                  "participants": ["2"]}
        memory.save_episode_vector(first, [0.1, 0.2, 0.3])
        memory.save_episode_vector(second, [0.3, 0.2, 0.1])
        with self.assertRaises(ValueError):
            memory.delete_memories()
        self.assertEqual(memory.delete_memories({"ids": ["episode-user-1"], "user_id": "2"}), 0)
        self.assertEqual(memory.count_memories({"user_id": "1"}), 1)
        self.assertEqual(memory.count_memories({"user_id": "2"}), 1)

    def test_memory_delete_and_count_include_episodes(self):
        episode = {
            "id": "episode-test-1", "text": "Alice event", "session_key": "user:1",
            "date": "2026-11-25", "period": "night", "start_time": "2026-11-25T00:00:00Z",
            "end_time": "2026-11-25T00:00:00Z", "participants": ["1"],
            "created_at": "2026-11-25T00:00:00Z",
        }
        memory.save_episode_vector(episode, [0.1, 0.2, 0.3])
        self.assertEqual(memory.count_memories({"user_id": "1"}), 1)
        self.assertEqual(memory.list_memories({"session_key": "user:1"})[0]["type"], "episodic")
        self.assertEqual(memory.delete_memories({"user_id": "1"}), 1)
        self.assertEqual(memory.count_memories(), 0)

    def test_episode_id_and_episode_grouping_are_deterministic(self):
        ident = memory.episode_id("user:1", "2026-11-25T00:00:00Z")
        self.assertEqual(ident, memory.episode_id("user:1", "2026-11-25T00:00:00Z"))
        episode = memory.build_episode([
            {"timestamp": "2026-11-25T01:00:00Z", "summary": "First event", "user_id": "1"},
            {"timestamp": "2026-11-25T01:05:00Z", "summary": "Second event", "user_id": "2"},
        ], "user:1")
        self.assertIn("First event", episode["text"])
        self.assertIn("Second event", episode["text"])
        self.assertEqual(episode["participants"], ["1", "2"])


if __name__ == "__main__":
    unittest.main()
