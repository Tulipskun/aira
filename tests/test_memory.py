from __future__ import annotations
import asyncio
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch
from aira import memory
from aira.config import config
from aira.store import Store

class MemoryTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.old_store=memory.store
        memory.store=Store(Path(self.temp.name)/"test.db")
        memory._initialize_tables()
        self.old_max=config.episode_max_results
        self.old_min=config.episode_min_similarity
        config.episode_max_results=5
        config.episode_min_similarity=0.0

    def tearDown(self):
        memory.store.close()
        memory.store=self.old_store
        config.episode_max_results=self.old_max
        config.episode_min_similarity=self.old_min
        self.temp.cleanup()

    def test_semantic_memory_is_session_scoped(self):
        memory.save_memory_vector("Alice likes tea",[1,0,0],"1","2026-11-25T00:00:00Z","user:1")
        memory.save_memory_vector("Bob likes coffee",[0,1,0],"2","2026-11-25T00:00:00Z","user:2")
        self.assertEqual(memory.count_memories({"session_key":"user:1"}),1)
        rows=memory.search_memories_by_vector([1,0,0],"user:1",5,0.5)
        self.assertEqual([row["text"] for row in rows],["Alice likes tea"])

    def test_legacy_room_memory_moves_to_isla_without_moving_other_characters(self):
        memory.save_memory_vector("Isla memory", [1, 0, 0], "1", "2026-11-25T00:00:00Z", "group:9")
        memory.save_memory_vector("Nova memory", [0, 1, 0], "1", "2026-11-25T00:00:00Z",
                                  "group:9:character:nova")
        episode = {"id": "old-episode", "text": "Isla episode", "session_key": "group:9",
                   "date": "2026-11-25", "period": "night", "start_time": "2026-11-25T00:00:00Z",
                   "end_time": "2026-11-25T00:01:00Z", "participants": ["1"],
                   "created_at": "2026-11-25T00:01:00Z"}
        memory.save_episode_vector(episode, [1, 0, 0])
        migrated = memory.migrate_character_memory_sessions()
        self.assertEqual(migrated, {"semantic_memories": 1, "episodic_memories": 1})
        self.assertEqual(memory.count_memories({"session_key": "group:9:character:isla"}), 2)
        self.assertEqual(memory.count_memories({"session_key": "group:9:character:nova"}), 1)
        self.assertEqual(memory.migrate_character_memory_sessions(),
                         {"semantic_memories": 0, "episodic_memories": 0})

    def test_episode_history_is_filtered_to_the_character_who_created_it(self):
        memory.store.save_message("model", "Isla text", "2026-11-25T01:00:00Z", "group:9",
                                  None, "Isla", None, "Isla memory", "isla")
        memory.store.save_message("model", "Nova text", "2026-11-25T01:02:00Z", "group:9",
                                  None, "Nova", None, "Nova memory", "nova")
        episode = asyncio.run(memory.build_recent_episode(
            "group:9:character:nova", "group:9", "nova",
        ))
        self.assertEqual(episode["text"], "Nova memory")

    def test_memory_crud(self):
        ident=memory.save_memory_vector("Tea",[1,0,0],"1","2026-11-25T00:00:00Z","user:1")
        self.assertEqual(len(memory.list_memories({"user_id":"1"})),1)
        self.assertEqual(memory.delete_memories({"ids":[ident]}),1)
        memory.save_memory_vector("Coffee",[0,1,0],"2","2026-11-25T00:00:00Z","user:2")
        self.assertEqual(memory.clear_memories(),1)
        self.assertEqual(memory.count_memories(),0)

    def test_legacy_records_are_assigned_a_session(self):
        memory.store.db.execute("""INSERT INTO semantic_memories(id,text,embedding_json,user_id,timestamp,session_key,metadata_json)
            VALUES('legacy','Legacy memory','[1,0,0]','42','2026-11-25T00:00:00Z','','{}')""")
        result=asyncio.run(memory.migrate_memory_sessions())
        self.assertEqual(result["backfilled"],1)
        self.assertEqual(memory.list_memories({"session_key":"user:42"})[0]["text"],"Legacy memory")

    def test_delete_requires_scope_and_respects_user_boundary(self):
        base={"text":"Alice event","session_key":"user:1","date":"2026-11-25","period":"night",
              "start_time":"2026-11-25T00:00:00Z","end_time":"2026-11-25T00:00:00Z",
              "participants":["1"],"created_at":"2026-11-25T00:00:00Z"}
        memory.save_episode_vector({"id":"episode-1",**base},[1,0,0])
        memory.save_episode_vector({"id":"episode-2",**{**base,"session_key":"user:2","participants":["2"]}},[0,1,0])
        with self.assertRaises(ValueError): memory.delete_memories()
        self.assertEqual(memory.delete_memories({"ids":["episode-1"],"user_id":"2"}),0)
        self.assertEqual(memory.count_memories({"user_id":"1"}),1)
        self.assertEqual(memory.count_memories({"user_id":"2"}),1)

    def test_episode_count_list_and_delete(self):
        episode={"id":"episode-test-1","text":"Alice event","session_key":"user:1","date":"2026-11-25",
                 "period":"night","start_time":"2026-11-25T00:00:00Z","end_time":"2026-11-25T00:00:00Z",
                 "participants":["1"],"created_at":"2026-11-25T00:00:00Z"}
        memory.save_episode_vector(episode,[1,0,0])
        self.assertEqual(memory.count_memories({"user_id":"1"}),1)
        self.assertEqual(memory.list_memories({"session_key":"user:1"})[0]["type"],"episodic")
        self.assertEqual(memory.delete_memories({"user_id":"1"}),1)
        self.assertEqual(memory.count_memories(),0)

    def test_episode_id_and_grouping_are_deterministic(self):
        ident=memory.episode_id("user:1","2026-11-25T00:00:00Z")
        self.assertEqual(ident,memory.episode_id("user:1","2026-11-25T00:00:00Z"))
        episode=memory.build_episode([
            {"timestamp":"2026-11-25T01:00:00Z","summary":"First event","user_id":"1"},
            {"timestamp":"2026-11-25T01:05:00Z","summary":"Second event","user_id":"2"}],"user:1")
        self.assertIn("First event",episode["text"])
        self.assertIn("Second event",episode["text"])
        self.assertEqual(episode["participants"],["1","2"])

    def test_cosine_similarity_orders_nearest_first(self):
        memory.save_memory_vector("nearest",[1,0,0],"1","2026-11-25T00:00:00Z","user:1")
        memory.save_memory_vector("far",[0,1,0],"1","2026-11-25T00:00:00Z","user:1")
        rows=memory.search_memories_by_vector([1,0,0],"user:1",2)
        self.assertEqual([row["text"] for row in rows],["nearest","far"])

    def test_background_ingestion_saves_and_deduplicates_memory(self):
        with patch.object(memory, "embed", new=AsyncMock(return_value=[1, 0, 0])) as embed_mock:
            asyncio.run(memory.ingest_memory_background(
                "Alice likes tea", "1", "2026-11-25T00:00:00Z", "user:1"))
            asyncio.run(memory.ingest_memory_background(
                "Alice likes tea", "1", "2026-11-25T00:00:00Z", "user:1"))
        self.assertEqual(embed_mock.await_count, 2)
        self.assertEqual(memory.count_memories({"session_key": "user:1"}), 1)

    def test_background_episode_persistence(self):
        episode = {"id": "episode-background", "text": "Alice event"}
        with patch.object(memory, "build_recent_episode", new=AsyncMock(return_value=episode)) as build, \
             patch.object(memory, "save_episode", new=AsyncMock()) as save:
            asyncio.run(memory.persist_episode_background("user:1"))
        build.assert_awaited_once_with("user:1")
        save.assert_awaited_once_with(episode)


if __name__=="__main__": unittest.main()
