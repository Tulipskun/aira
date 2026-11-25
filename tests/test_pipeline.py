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
        self.generate = AsyncMock(return_value={
            "reply": "สวัสดี", "summary": "ทักทาย", "memory": "",
            "relationship": "เราเริ่มคุ้นเคยและคุยกันได้อย่างสบายใจ",
            "relationships": [], "next_speaker_id": "rem",
            "mood": "ดีใจ", "color": 0x123456, "image": "smile.png", "rps": None,
        })
        self.patches = [
            patch.object(pipeline, "store", self.store),
            patch.object(pipeline, "embed", new=AsyncMock(return_value=[0.25, 0.75])),
            patch.object(pipeline, "search_memories_by_vector", return_value=[]),
            patch.object(pipeline, "recall_episodes", new=AsyncMock(return_value=[])),
            patch.object(pipeline, "generate_character_reply", new=self.generate),
            patch.object(pipeline, "_spawn", side_effect=lambda coroutine: coroutine.close()),
        ]
        for item in self.patches:
            item.start()

    async def asyncTearDown(self):
        for item in reversed(self.patches):
            item.stop()
        self.store.close()
        self.temp.cleanup()

    async def test_speaker_selection_uses_model_and_never_defaults_to_isla(self):
        chars = [
            Character("isla", "Isla", ("Isla",), Path("isla.md")),
            Character("rem", "Rem", ("Rem",), Path("rem.md")),
            Character("bocchi", "Bocchi", ("Bocchi",), Path("bocchi.md")),
        ]
        with patch.object(pipeline, "load_characters", return_value=chars), \
             patch.object(pipeline, "generate_json", new=AsyncMock(return_value={"selected_character_ids": ["bocchi", "rem"], "reason": "หัวข้อเหมาะกับทั้งคู่"})) as selector:
            selected = await pipeline.select_characters({
                "text": "วันนี้เป็นยังไง", "session_key": "group:99", "user_id": "alice", "user": "Alice",
            })
        self.assertEqual([item.id for item in selected], ["bocchi", "rem"])
        selector.assert_awaited_once()

    async def test_named_character_is_hinted_to_the_selector_instead_of_short_circuited(self):
        chars = [
            Character("isla", "Isla", ("Isla",), Path("isla.md")),
            Character("rem", "Rem", ("Rem",), Path("rem.md")),
            Character("bocchi", "Bocchi", ("Bocchi",), Path("bocchi.md")),
        ]
        captured = {}

        async def fake_generate(stage, prompt, system, **kwargs):
            captured["prompt"] = prompt
            captured["kwargs"] = kwargs
            return {"selected_character_ids": ["rem"], "reason": "ผู้ใช้เรียกเรม"}

        with patch.object(pipeline, "load_characters", return_value=chars), \
             patch.object(pipeline, "generate_json", new=AsyncMock(side_effect=fake_generate)) as selector:
            selected = await pipeline.select_characters({"text": "Rem ช่วยตอบหน่อย",
                                                         "session_key": "group:named"})
        self.assertEqual([item.id for item in selected], ["rem"])
        selector.assert_awaited_once()
        self.assertIn("เบาะแสเท่านั้น", captured["prompt"])
        self.assertIn("ต้องตัดสินจากบริบท", captured["prompt"])
        self.assertTrue(captured["kwargs"]["fast"])  # short decision answer, small output cap

    async def test_a_name_only_mentioned_is_not_forced_into_the_selection(self):
        chars = [
            Character("isla", "Isla", ("Isla",), Path("isla.md")),
            Character("rem", "Rem", ("Rem",), Path("rem.md")),
        ]
        with patch.object(pipeline, "load_characters", return_value=chars), \
             patch.object(pipeline, "generate_json", new=AsyncMock(
                 return_value={"addressed_to": "isla", "mentioned_only": ["rem"],
                               "selected_character_ids": ["isla"],
                               "reason": "ผู้ใช้เล่าเรื่องเรมให้ไอล่าฟัง"})
             ):
            selected = await pipeline.select_characters({
                "text": "ไอล่า เมื่อกี้เรมบอกว่าชอบชาไง", "session_key": "group:mention",
            })
        self.assertEqual([item.id for item in selected], ["isla"])

    async def test_the_character_the_message_speaks_to_is_not_dropped(self):
        chars = [
            Character("isla", "Isla", ("Isla",), Path("isla.md")),
            Character("origami", "Origami Tobiichi", ("Origami",), Path("origami.md")),
        ]
        with patch.object(pipeline, "load_characters", return_value=chars), \
             patch.object(pipeline, "generate_json", new=AsyncMock(
                 return_value={"addressed_to": "origami", "mentioned_only": [],
                               "selected_character_ids": ["isla"],
                               "reason": "โมเดลเลือกพลาด"})
             ):
            selected = await pipeline.select_characters({
                "text": "โอริกามิ ไปไหนมา", "session_key": "group:addressed",
            })
        self.assertEqual([item.id for item in selected][0], "origami")

    async def test_selector_can_choose_silence_and_invalid_output_does_not_fall_back_to_isla(self):
        chars = [Character("isla", "Isla", ("Isla",), Path("isla.md"))]
        with patch.object(pipeline, "load_characters", return_value=chars), \
             patch.object(pipeline, "generate_json", new=AsyncMock(return_value={"selected_character_ids": [], "reason": "ไม่มีใครอยากพูด"})):
            self.assertEqual(await pipeline.select_characters({"text": "ข้อความทั่วไป", "session_key": "group:99"}), [])
        with patch.object(pipeline, "load_characters", return_value=chars), \
             patch.object(pipeline, "generate_json", new=AsyncMock(return_value=None)):
            self.assertEqual(await pipeline.select_characters({"text": "ข้อความทั่วไป", "session_key": "group:99"}), [])

    async def test_selector_sees_unanswered_messages_and_breaks_a_silent_room(self):
        chars = [
            Character("isla", "Isla", ("Isla",), Path("isla.md")),
            Character("rem", "Rem", ("Rem",), Path("rem.md")),
            Character("bocchi", "Bocchi", ("Bocchi",), Path("bocchi.md")),
        ]
        session = "group:silence"
        self.store.save_message("model", "เดี๋ยวเรมไปดูให้นะคะ", utc_now(), session, None, "Rem", None, None, "rem")
        self.store.save_message("user", "ว่าไงบ้าง", utc_now(), session, "1", "Farris", None, None)
        self.store.save_message("user", "น้องเงียบเลย 5555", utc_now(), session, "2", "Yuuta", None, None)
        captured = {}

        async def fake_generate(stage, prompt, system, **kwargs):
            captured["prompt"] = prompt
            return {"selected_character_ids": [], "reason": "ไม่มีใครจำเป็นต้องตอบ"}

        with patch.object(pipeline, "load_characters", return_value=chars), \
             patch.object(pipeline, "generate_json", new=AsyncMock(side_effect=fake_generate)):
            selected = await pipeline.select_characters({
                "text": "น้องเงียบเลย 5555", "session_key": session, "user_id": "2", "user": "Yuuta",
            })
        # Two unanswered messages in a row: the last speaker keeps the conversation going.
        self.assertEqual([item.id for item in selected], ["rem"])
        self.assertIn("ข้อความนี้ยังไม่มีตัวละครตอบ", captured["prompt"])
        self.assertIn("จำนวนข้อความท้ายห้องที่ยังไม่มีตัวละครตอบ: 2", captured["prompt"])

    async def test_selector_still_allows_silence_for_laughter_or_a_first_message(self):
        chars = [
            Character("isla", "Isla", ("Isla",), Path("isla.md")),
            Character("rem", "Rem", ("Rem",), Path("rem.md")),
        ]
        session = "group:noise"
        self.store.save_message("model", "ค่ะ", utc_now(), session, None, "Rem", None, None, "rem")
        self.store.save_message("user", "55555", utc_now(), session, "1", "Yuuta", None, None)
        with patch.object(pipeline, "load_characters", return_value=chars), \
             patch.object(pipeline, "generate_json", new=AsyncMock(
                 return_value={"selected_character_ids": [], "reason": "เสียงหัวเราะล้วน ๆ"})):
            # A single unanswered laugh stays silent.
            self.assertEqual(await pipeline.select_characters({
                "text": "55555", "session_key": session, "user_id": "1", "user": "Yuuta",
            }), [])
        session = "group:noise2"
        self.store.save_message("model", "ค่ะ", utc_now(), session, None, "Rem", None, None, "rem")
        self.store.save_message("user", "55555", utc_now(), session, "1", "Yuuta", None, None)
        self.store.save_message("user", "55555", utc_now(), session, "1", "Yuuta", None, None)
        with patch.object(pipeline, "load_characters", return_value=chars), \
             patch.object(pipeline, "generate_json", new=AsyncMock(
                 return_value={"selected_character_ids": [], "reason": "เสียงหัวเราะล้วน ๆ"})):
            self.assertEqual(await pipeline.select_characters({
                "text": "55555", "session_key": session, "user_id": "1", "user": "Yuuta",
            }), [])

    async def test_room_wide_greeting_asks_the_selector_for_everyone_named(self):
        chars = [
            Character("isla", "Isla", ("Isla",), Path("isla.md")),
            Character("rem", "Rem", ("Rem",), Path("rem.md")),
            Character("bocchi", "Bocchi", ("Bocchi", "โบจจิ", "บจจิ"), Path("bocchi.md")),
            Character("origami", "Origami Tobiichi", ("Origami", "โอริกามิ"), Path("origami.md")),
        ]
        captured = {}

        async def fake_generate(stage, prompt, system, **kwargs):
            captured["prompt"] = prompt
            return {"selected_character_ids": ["bocchi", "isla", "origami", "rem"],
                    "reason": "ผู้ใช้เรียกทุกคนให้ทักทาย"}

        with patch.object(pipeline, "load_characters", return_value=chars), \
             patch.object(pipeline, "generate_json", new=AsyncMock(side_effect=fake_generate)):
            selected = await pipeline.select_characters({
                "text": "บจจิ, เรม, โอริกามิ, ไอลาๆๆ ทักทายเพื่อนใหม่กันหน่อย",
                "session_key": "group:greet",
            })
        self.assertEqual([item.id for item in selected], ["bocchi", "isla", "origami", "rem"])
        self.assertIn("ชื่อที่ตัวจับชื่อเห็นในข้อความนี้ (เบาะแสเท่านั้น", captured["prompt"])
        self.assertIn("เลือกได้ 0-4 คน", captured["prompt"])

    async def test_broadcast_word_keeps_the_selector_in_charge(self):
        chars = [
            Character("isla", "Isla", ("Isla",), Path("isla.md")),
            Character("rem", "Rem", ("Rem",), Path("rem.md")),
            Character("origami", "Origami Tobiichi", ("Origami", "โอริกามิ"), Path("origami.md")),
        ]
        with patch.object(pipeline, "load_characters", return_value=chars), \
             patch.object(pipeline, "generate_json", new=AsyncMock(
                 return_value={"selected_character_ids": ["isla", "rem", "origami"],
                               "reason": "ทุกคนในห้องควรทักทาย"})) as selector:
            selected = await pipeline.select_characters({
                "text": "ทุกคนทักทายโอริกามิกันหน่อย", "session_key": "group:greet2",
            })
        self.assertEqual([item.id for item in selected], ["isla", "rem", "origami"])
        selector.assert_awaited_once()

    async def test_isla_uses_the_shared_character_pipeline_and_relationship_model(self):
        result = await pipeline.process_message({
            "user_id": "alice", "user": "Alice", "text": "Hi Isla",
            "timestamp": utc_now(), "session_key": "group:99",
        }, SimpleNamespace(parts=[], summary="", file_names=[]))
        self.assertEqual(result["text"], "สวัสดี")
        self.assertEqual(result["mood"], "ดีใจ")
        self.assertEqual(result["color"], 0x123456)
        self.assertEqual(result["image"], "smile.png")
        self.assertEqual(result["next_speaker_id"], "rem")
        self.assertEqual(pipeline.generate_character_reply.await_count, 1)
        prompt, context = self.generate.await_args.args[:2]
        self.assertIn("ไม่มีคะแนน XP", prompt)
        self.assertIn("mood", prompt)
        self.assertIn("select_image", prompt)
        self.assertIn("current_time", context)
        self.assertIn("เวลาของข้อความต้นทาง", context)
        self.assertEqual(pipeline.search_memories_by_vector.call_args.args[1],
                         "group:99:character:isla")
        self.assertEqual(pipeline.search_memories_by_vector.call_args.kwargs["user_id"], "alice")
        saved = self.store.get_history(10, "group:99")[-1]
        self.assertEqual(saved["character_id"], "isla")
        self.assertEqual(self.store.get_character_relationship("isla", "alice"),
                         "เราเริ่มคุ้นเคยและคุยกันได้อย่างสบายใจ")
        self.assertNotIn("xp", self.store.get_character_relationship("isla", "alice").lower())

    async def test_group_turn_does_not_merge_distinct_user_profiles(self):
        result = await pipeline.process_message({
            "user_id": "bob", "user": "Bob", "text": "Alice: สวัสดี\nBob: ขอถามหน่อย",
            "timestamp": utc_now(), "session_key": "group:99",
            "speakers": [
                {"user_id": "alice", "user": "Alice"},
                {"user_id": "bob", "user": "Bob"},
            ],
        }, SimpleNamespace(parts=[], summary="", file_names=[]))
        self.assertEqual(result["text"], "สวัสดี")
        self.assertEqual(self.store.get_character_relationship("isla", "alice"),
                         "ยังไม่เคยสร้างความสัมพันธ์")
        self.assertEqual(self.store.get_character_relationship("isla", "bob"),
                         "เราเริ่มคุ้นเคยและคุยกันได้อย่างสบายใจ")
        messages = self.store.get_history(10, "group:99")
        self.assertEqual([row["role"] for row in messages], ["user", "model"])
        self.assertEqual(result["session_key"], "group:99")

    async def test_all_characters_share_same_metadata_schema_and_memory_namespace(self):
        character = Character("nova", "Nova", ("Nova",), Path("nova.md"))
        with patch.object(pipeline, "load_characters", return_value=[
            Character("isla", "Isla", ("Isla",), Path("isla.md")), character,
        ]), patch.object(pipeline, "load_character_prompt", return_value="Nova prompt"):
            result = await pipeline.process_character_reply({
                "user_id": "alice", "user": "Alice", "text": "Nova, คิดยังไง",
                "timestamp": utc_now(), "session_key": "group:99",
            }, character, SimpleNamespace(parts=[], summary="", file_names=[]))
        self.assertEqual(result["text"], "สวัสดี")
        self.assertEqual(result["mood"], "ดีใจ")
        self.assertEqual(result["color"], 0x123456)
        self.assertEqual(result["image"], "smile.png")
        self.assertIn("ความสัมพันธ์", self.generate.await_args.args[0])
        self.assertIn("ไม่มีคะแนน XP", self.generate.await_args.args[0])
        self.assertEqual(pipeline.search_memories_by_vector.call_args.args[1],
                         "group:99:character:nova")
        saved = self.store.get_history(10, "group:99")[-1]
        self.assertEqual(saved["character_id"], "nova")

    async def test_character_to_character_turn_updates_directional_pair_not_human_relationship(self):
        character = Character("nova", "Nova", ("Nova",), Path("nova.md"))
        self.generate.return_value = {
            "reply": "ฉันเห็นด้วย", "summary": "คุยกับ Isla", "memory": "",
            "relationship": "Nova เริ่มไว้วางใจ Isla มากขึ้น", "relationships": [],
            "next_speaker_id": "", "mood": "สงบ", "color": 0x00AA88,
            "image": "", "rps": None,
        }
        with patch.object(pipeline, "load_characters", return_value=[
            Character("isla", "Isla", ("Isla",), Path("isla.md")), character,
        ]), patch.object(pipeline, "load_character_prompt", return_value="Nova prompt"):
            await pipeline.process_character_reply({
                "user_id": "alice", "user": "Alice", "text": "ฉันเห็นด้วย",
                "timestamp": utc_now(), "session_key": "group:99",
                "character_turn": True, "trigger_character": "Isla",
                "trigger_character_id": "isla",
            }, character, SimpleNamespace(parts=[], summary="", file_names=[]), input_saved=True)
        self.assertEqual(self.store.get_character_relationship("nova", "alice"),
                         "ยังไม่เคยสร้างความสัมพันธ์")
        self.assertEqual(self.store.get_character_pair_relationship("nova", "isla"),
                         "Nova เริ่มไว้วางใจ Isla มากขึ้น")
        pipeline.embed.assert_not_awaited()

    async def test_user_facts_are_available_without_exposing_legacy_relationship_scores(self):
        self.store.upsert_profile("alice", user_name="Alice", nickname=["ชาเขียว"],
                                  facts=[{"text": "Alice ชอบชา", "timestamp": utc_now(), "status": "confirmed"}])
        character = Character("nova", "Nova", ("Nova",), Path("nova.md"))
        with patch.object(pipeline, "load_characters", return_value=[
            Character("isla", "Isla", ("Isla",), Path("isla.md")), character,
        ]), patch.object(pipeline, "load_character_prompt", return_value="Nova prompt"):
            await pipeline.process_character_reply({
                "user_id": "alice", "user": "Alice", "text": "สวัสดี",
                "session_key": "group:99",
            }, character, SimpleNamespace(parts=[], summary="", file_names=[]))
        context = self.generate.await_args.args[1]
        prompt = self.generate.await_args.args[0]
        self.assertIn("ชาเขียว", context)
        self.assertIn("Alice ชอบชา", context)
        self.assertIn("ไม่มีคะแนน XP", prompt)
        self.assertNotIn("flirt_count", prompt)


    async def test_user_facts_and_accepted_nicknames_are_preserved_without_relationship_scores(self):
        self.generate.return_value = {
            "reply": "สวัสดี", "summary": "", "memory": "", "relationship": "",
            "relationships": [], "next_speaker_id": "", "mood": "สงบ",
            "color": 0x123456, "image": "", "rps": None,
            "facts": [{"text": "Alice ชอบชาเขียว", "owner_user_id": "alice",
                       "confirmed_by_owner": True, "replaces_fact": ""}],
            "nicknames": ["คนรักชา"],
        }
        await pipeline.process_message({
            "user_id": "alice", "user": "Alice", "text": "ฉันชอบชาเขียว",
            "timestamp": utc_now(), "session_key": "group:99",
        }, SimpleNamespace(parts=[], summary="", file_names=[]))
        profile = self.store.get_profile("alice")
        self.assertEqual(profile["facts"][0]["text"], "Alice ชอบชาเขียว")
        self.assertEqual(profile["nickname"], ["คนรักชา"])

    async def test_private_turn_persists_in_private_session(self):
        result = await pipeline.process_message({
            "user_id": "alice", "user": "Alice", "text": "Hi",
            "timestamp": utc_now(), "session_key": "user:alice",
        }, SimpleNamespace(parts=[], summary="", file_names=[]))
        self.assertEqual(result["session_key"], "user:alice")
        self.assertEqual(self.store.count_messages(session_key="user:alice"), 2)


if __name__ == "__main__":
    unittest.main()
