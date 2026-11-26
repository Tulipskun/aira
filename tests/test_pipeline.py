import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from aira import pipeline
from aira.characters import Character
from aira.token_budget import HISTORY_WINDOW_TOKENS
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
             patch.object(pipeline, "decide_speakers", new=AsyncMock(
                 return_value={"bocchi": 0.91, "rem": 0.84, "isla": 0.08})) as selector:
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

        async def fake_decide(shared_input, questions):
            captured["input"] = shared_input
            captured["questions"] = questions
            return {"rem": 0.94, "isla": 0.05, "bocchi": 0.02}

        with patch.object(pipeline, "load_characters", return_value=chars), \
             patch.object(pipeline, "decide_speakers", new=AsyncMock(side_effect=fake_decide)) as selector:
            selected = await pipeline.select_characters({"text": "Rem ช่วยตอบหน่อย",
                                                         "session_key": "group:named"})
        self.assertEqual([item.id for item in selected], ["rem"])
        selector.assert_awaited_once()
        self.assertIn("เบาะแสเท่านั้น", captured["input"])
        self.assertEqual(set(captured["questions"]), {"isla", "rem", "bocchi"})

    async def test_a_name_only_mentioned_is_not_forced_into_the_selection(self):
        chars = [
            Character("isla", "Isla", ("Isla",), Path("isla.md")),
            Character("rem", "Rem", ("Rem",), Path("rem.md")),
        ]
        with patch.object(pipeline, "load_characters", return_value=chars), \
             patch.object(pipeline, "decide_speakers", new=AsyncMock(
                 return_value={"isla": 0.88, "rem": 0.31})):
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
             patch.object(pipeline, "decide_speakers", new=AsyncMock(
                 return_value={"origami": 0.93, "isla": 0.12})):
            selected = await pipeline.select_characters({
                "text": "โอริกามิ ไปไหนมา", "session_key": "group:addressed",
            })
        self.assertEqual([item.id for item in selected][0], "origami")

    async def test_selector_can_choose_silence_and_invalid_output_does_not_fall_back_to_isla(self):
        chars = [Character("isla", "Isla", ("Isla",), Path("isla.md"))]
        with patch.object(pipeline, "load_characters", return_value=chars), \
             patch.object(pipeline, "decide_speakers", new=AsyncMock(return_value={"isla": 0.12})):
            self.assertEqual(await pipeline.select_characters({"text": "ข้อความทั่วไป", "session_key": "group:99"}), [])
        with patch.object(pipeline, "load_characters", return_value=chars), \
             patch.object(pipeline, "decide_speakers", new=AsyncMock(side_effect=RuntimeError("decision down"))):
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

        async def fake_generate(shared_input, questions):
            captured["prompt"] = shared_input
            return {"rem": 0.2, "isla": 0.1, "bocchi": 0.05}

        with patch.object(pipeline, "load_characters", return_value=chars), \
             patch.object(pipeline, "decide_speakers", new=AsyncMock(side_effect=fake_generate)):
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
             patch.object(pipeline, "decide_speakers", new=AsyncMock(
                 return_value={"isla": 0.1, "rem": 0.08})):
            # A single unanswered laugh stays silent.
            self.assertEqual(await pipeline.select_characters({
                "text": "55555", "session_key": session, "user_id": "1", "user": "Yuuta",
            }), [])
        session = "group:noise2"
        self.store.save_message("model", "ค่ะ", utc_now(), session, None, "Rem", None, None, "rem")
        self.store.save_message("user", "55555", utc_now(), session, "1", "Yuuta", None, None)
        self.store.save_message("user", "55555", utc_now(), session, "1", "Yuuta", None, None)
        with patch.object(pipeline, "load_characters", return_value=chars), \
             patch.object(pipeline, "decide_speakers", new=AsyncMock(
                 return_value={"isla": 0.12, "rem": 0.07})):
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

        async def fake_generate(shared_input, questions):
            captured["prompt"] = shared_input
            return {"bocchi": 0.8, "isla": 0.75, "origami": 0.79, "rem": 0.81}

        with patch.object(pipeline, "load_characters", return_value=chars), \
             patch.object(pipeline, "decide_speakers", new=AsyncMock(side_effect=fake_generate)):
            selected = await pipeline.select_characters({
                "text": "บจจิ, เรม, โอริกามิ, ไอลาๆๆ ทักทายเพื่อนใหม่กันหน่อย",
                "session_key": "group:greet",
            })
        self.assertEqual({item.id for item in selected}, {"bocchi", "isla", "origami", "rem"})
        self.assertIn("ชื่อที่ตัวจับชื่อเห็นในข้อความนี้ (เบาะแสเท่านั้น", captured["prompt"])

    async def test_broadcast_word_keeps_the_selector_in_charge(self):
        chars = [
            Character("isla", "Isla", ("Isla",), Path("isla.md")),
            Character("rem", "Rem", ("Rem",), Path("rem.md")),
            Character("origami", "Origami Tobiichi", ("Origami", "โอริกามิ"), Path("origami.md")),
        ]
        with patch.object(pipeline, "load_characters", return_value=chars), \
             patch.object(pipeline, "decide_speakers", new=AsyncMock(
                 return_value={"isla": 0.7, "rem": 0.66, "origami": 0.72})) as selector:
            selected = await pipeline.select_characters({
                "text": "ทุกคนทักทายโอริกามิกันหน่อย", "session_key": "group:greet2",
            })
        self.assertEqual({item.id for item in selected}, {"isla", "rem", "origami"})
        selector.assert_awaited_once()

    async def test_every_character_can_be_selected_in_one_turn(self):
        chars = [
            Character("isla", "Isla", ("Isla",), Path("isla.md")),
            Character("rem", "Rem", ("Rem",), Path("rem.md")),
            Character("bocchi", "Bocchi", ("Bocchi",), Path("bocchi.md")),
            Character("origami", "Origami Tobiichi", ("Origami",), Path("origami.md")),
        ]
        captured = {}

        async def fake_generate(shared_input, questions):
            captured["prompt"] = shared_input
            return {item.id: 0.8 for item in chars}

        with patch.object(pipeline, "load_characters", return_value=chars), \
             patch.object(pipeline, "decide_speakers", new=AsyncMock(side_effect=fake_generate)):
            selected = await pipeline.select_characters({
                "text": "ทุกคนทักทายโอริกามิกันหน่อย", "session_key": "group:all",
            })
        # Room-wide requests follow the room order, not the model's list order.
        self.assertEqual([item.id for item in selected], [item.id for item in chars])

    async def test_a_call_to_the_whole_room_wakes_every_character(self):
        chars = [
            Character("isla", "Isla", ("Isla",), Path("isla.md")),
            Character("rem", "Rem", ("Rem",), Path("rem.md")),
            Character("bocchi", "Bocchi", ("Bocchi",), Path("bocchi.md")),
            Character("origami", "Origami Tobiichi", ("Origami",), Path("origami.md")),
        ]
        with patch.object(pipeline, "load_characters", return_value=chars), \
             patch.object(pipeline, "decide_speakers", new=AsyncMock(
                 return_value={item.id: 0.85 for item in chars})):
            selected = await pipeline.select_characters({
                "text": "ทุกคนคิดว่ายังไงบ้าง", "session_key": "group:room4",
            })
        self.assertEqual({item.id for item in selected}, {item.id for item in chars})

    async def test_no_speaker_cap_lets_every_character_answer(self):
        chars = [Character(f"c{index}", f"C{index}", (f"C{index}",), Path(f"c{index}.md"))
                 for index in range(6)]
        with patch.object(pipeline, "load_characters", return_value=chars), \
             patch.object(pipeline, "decide_speakers", new=AsyncMock(
                 return_value={item.id: 0.9 for item in chars})):
            selected = await pipeline.select_characters({
                "text": "ทุกคนช่วยแชร์ความเห็นหน่อย", "session_key": "group:nocap",
            })
        self.assertEqual({item.id for item in selected}, {item.id for item in chars})

    async def test_the_model_names_the_line_the_room_still_owes(self):
        session = "group:thread"
        self.store.save_message("user", "แล้วพรุ่งนี้ไปไหนกันดี", utc_now(), session, "1", "Yuuta")
        with patch.object(pipeline.gemini, "decide_open_thread", return_value="m1") as decided:
            self.assertEqual(await pipeline.open_thread(session), "แล้วพรุ่งนี้ไปไหนกันดี")
        self.assertTrue(decided.await_args.args[0].startswith("Yuuta: แล้วพรุ่งนี้ไปไหนกันดี"))

    async def test_a_question_between_characters_is_settled_by_the_model(self):
        session = "group:bantar"
        self.store.save_message("model", "วันนี้ฝึกซ้อมกันหนักมากเลยนะคะ", utc_now(), session,
                                None, "Rem", None, None, "rem")
        self.store.save_message("model", "คุณโอริกามิจะซ้อมต่อไหมคะ?", utc_now(), session,
                                None, "Isla", None, None, "isla")
        with patch.object(pipeline.gemini, "decide_open_thread", return_value="none"):
            self.assertEqual(await pipeline.open_thread(session), "")

    async def test_one_message_is_judged_once(self):
        session = "group:once"
        self.store.save_message("user", "ไปไหนกันดี", utc_now(), session, "1", "Yuuta")
        with patch.object(pipeline.gemini, "decide_open_thread", return_value="none") as decided:
            await pipeline.open_thread(session)
            await pipeline.open_thread(session)
        self.assertEqual(decided.await_count, 1)

    async def test_a_failed_judgement_leaves_the_room_settled(self):
        session = "group:broken"
        self.store.save_message("user", "ไปไหนกันดี", utc_now(), session, "1", "Yuuta")
        with patch.object(pipeline.gemini, "decide_open_thread", side_effect=RuntimeError("down")):
            self.assertEqual(await pipeline.open_thread(session), "")

    def test_the_room_is_read_back_to_a_token_window(self):
        session = "group:window"
        for index in range(200):
            self.store.save_message("user", f"ข้อความยาวพอสมควรหมายเลข {index} " * 3, utc_now(),
                                    session, "1", "Yuuta")
        window = pipeline.room_history(session)
        total = sum(pipeline.message_cost(row) for row in window)
        self.assertLessEqual(total, HISTORY_WINDOW_TOKENS)
        self.assertGreater(len(window), 1)
        self.assertEqual(window[-1]["text"].strip(), ("ข้อความยาวพอสมควรหมายเลข 199 " * 3).strip())

    def test_a_picture_in_the_room_shortens_the_window(self):
        session = "group:window-media"
        for index in range(80):
            self.store.save_message("user", f"ข้อความ {index}", utc_now(), session, "1", "Yuuta")
        plain = len(pipeline.room_history(session))
        for index in range(20):
            self.store.save_message("user", "ดูรูปนี้สิ", utc_now(), session, "1", "Yuuta",
                                    media_summary="แนบรูป 2 รูป: ภาพทุ่งดอกไม้, ภาพพระอาทิตย์ตก")
        with_media = len(pipeline.room_history(session))
        self.assertLess(with_media, plain + 20)

    async def test_a_topic_the_room_is_already_on_is_not_fresh(self):
        room = ["วันนี้ชาอุ่น ๆ อร่อยมากเลยนะคะ", "ไว้เรมชงให้อีกนะคะ"]

        async def near(text, task="query"):
            return [1.0, 0.0, 0.0]

        async def far(text, task="query"):
            return [0.0, 1.0, 0.0]

        with patch.object(pipeline, "embed", near):
            self.assertFalse(await pipeline.topic_is_fresh(
                "ชาอุ่น ๆ กำลังจะชงให้ทุกคน", room))
        with patch.object(pipeline, "embed", far):
            self.assertTrue(await pipeline.topic_is_fresh(
                "หนังที่เพิ่งเข้าฉายสัปดาห์นี้", room))

    async def test_a_greeting_opening_carries_the_moment_not_a_script(self):
        character = Character("origami", "Origami", ("Origami",), Path("origami.md"))
        message = {"user_id": "1", "user": "Yuuta", "text": "", "session_key": "group:quiet2",
                   "timestamp": utc_now(), "ambient": True, "idle_minutes": 90.0,
                   "idle_reason": "day_greeting", "part_of_day": "morning"}
        with patch.object(pipeline, "load_characters", return_value=[character]), \
             patch.object(pipeline, "load_character_prompt", return_value="prompt"), \
             patch.object(pipeline, "sample_memory") as sampled:
            await pipeline.process_character_reply(message, character, input_saved=True)
        context = self.generate.await_args.args[1]
        sampled.assert_not_called()
        self.assertIn("สถานะห้อง: ไม่มีเรื่องค้าง · ช่วงเวลาของวัน: morning", context)
        self.assertIn("สถานะ: ยังไม่มีใครทักทายกันในช่วงmorningนี้เลย", context)
        # Nothing is scripted for the character: no prewritten situation reaches her.
        self.assertNotIn("สถานการณ์", context)

    async def test_a_spontaneous_opening_is_fed_one_of_its_own_memories(self):
        character = Character("origami", "Origami", ("Origami",), Path("origami.md"))
        message = {"user_id": "1", "user": "Yuuta", "text": "", "session_key": "group:quiet3",
                   "timestamp": utc_now(), "ambient": True, "idle_minutes": 90.0,
                   "idle_reason": "spontaneous", "part_of_day": "evening"}
        with patch.object(pipeline, "load_characters", return_value=[character]), \
             patch.object(pipeline, "load_character_prompt", return_value="prompt"), \
             patch.object(pipeline, "sample_memory",
                          return_value="เคยสัญญากับคุณยูตะว่าจะไปดูดาวด้วยกัน") as sampled:
            await pipeline.process_character_reply(message, character, input_saved=True)
        context = self.generate.await_args.args[1]
        self.assertIn("เรื่องหนึ่งจากความทรงจำของคุณเอง: เคยสัญญากับคุณยูตะว่าจะไปดูดาวด้วยกัน",
                      context)
        sampled.assert_called_once()
        # The memory is chosen to differ from what the room is already discussing.
        self.assertIn("avoid", sampled.call_args.kwargs)

    async def test_a_character_that_repeats_itself_stays_silent(self):
        session = "group:echo"
        self.store.save_message("model", "ฉันอยู่ตรงนี้ มีธุระอะไรกับหน่วย AST หรือเปล่าคะ",
                                utc_now(), session, None, "Origami", None, None, "origami")
        self.generate.return_value = {
            "reply": "ฉันอยู่ตรงนี้ มีธุระอะไรกับหน่วย AST ไหมคะ", "summary": "",
            "memory": "", "relationship": "", "relationships": [], "next_speaker_id": "",
            "mood": "", "color": None, "image": "", "rps": None,
        }
        character = Character("origami", "Origami", ("Origami",), Path("origami.md"))
        with patch.object(pipeline, "load_characters", return_value=[character]), \
             patch.object(pipeline, "load_character_prompt", return_value="prompt"):
            result = await pipeline.process_character_reply(
                {"user_id": "1", "user": "Yuuta", "text": "ว่าไง", "session_key": session,
                 "timestamp": utc_now(), "character_turn": True,
                 "trigger_character": "Rem", "trigger_character_id": "rem"},
                character, input_saved=True,
            )
        self.assertEqual(result["text"], "")

    async def test_a_memory_that_echoes_the_current_room_is_not_injected(self):
        session = "group:echo-memory"
        self.store.save_message("model", "ฉันอยู่ตรงนี้ มีธุระอะไรกับหน่วย AST หรือเปล่าคะ",
                                utc_now(), session, None, "Origami", None, None, "origami")
        character = Character("origami", "Origami", ("Origami",), Path("origami.md"))
        with patch.object(pipeline, "load_characters", return_value=[character]), \
             patch.object(pipeline, "load_character_prompt", return_value="prompt"), \
             patch.object(pipeline, "search_memories_by_vector", return_value=[
                 {"text": "ฉันอยู่ตรงนี้ มีธุระอะไรกับหน่วย AST หรือเปล่าคะ", "timestamp": utc_now()},
                 {"text": "คุณยูตะชอบชาเขียว", "timestamp": utc_now()}]):
            await pipeline.process_character_reply(
                {"user_id": "1", "user": "Yuuta", "text": "ว่าไง", "session_key": session,
                 "timestamp": utc_now(), "character_turn": True,
                 "trigger_character": "Rem", "trigger_character_id": "rem"},
                character, input_saved=True,
            )
        context = self.generate.await_args.args[1]
        memory_section = context.split("สิ่งที่คุณจำได้เองเกี่ยวกับเรื่องนี้", 1)[-1]
        self.assertNotIn("มีธุระอะไรกับหน่วย AST", memory_section)
        self.assertIn("คุณยูตะชอบชาเขียว", memory_section)

    async def test_a_character_turn_treats_the_other_character_like_a_user(self):
        session = "group:duo"
        self.store.save_message("model", "รีบนอนเถอะค่ะ", utc_now(), session, None, "Rem",
                                None, None, "rem")
        character = Character("isla", "Isla", ("Isla",), Path("isla.md"))
        message = {"user_id": "1", "user": "Yuuta", "text": "รีบนอนเถอะค่ะ",
                   "session_key": session, "timestamp": utc_now(), "character_turn": True,
                   "trigger_character": "Rem", "trigger_character_id": "rem"}
        with patch.object(pipeline, "load_characters", return_value=[character]), \
             patch.object(pipeline, "load_character_prompt", return_value="prompt"), \
             patch.object(pipeline, "embed", new=AsyncMock(return_value=[0.1])) as embedded:
            await pipeline.process_character_reply(message, character, input_saved=True)
        context = self.generate.await_args.args[1]
        # The line from the other character arrives as a message with an identity.
        self.assertIn("ผู้ส่งข้อความ: Rem [character_id: rem]", context)
        self.assertIn("ข้อความจาก Rem: รีบนอนเถอะค่ะ", context)
        # And the character brings its own memories to it, like for a user message.
        embedded.assert_awaited()

    async def test_an_ambient_turn_starts_the_chat_and_still_recalls_memories(self):
        session = "group:quiet"
        self.store.save_message("user", "ไว้คุยกันใหม่นะ", utc_now(), session, "1", "Yuuta")
        character = Character("isla", "Isla", ("Isla",), Path("isla.md"))
        message = {"user_id": "1", "user": "Yuuta", "text": "ไว้คุยกันใหม่นะ",
                   "session_key": session, "timestamp": utc_now(),
                   "ambient": True, "idle_minutes": 24.0}
        with patch.object(pipeline, "load_characters", return_value=[character]), \
             patch.object(pipeline, "load_character_prompt", return_value="prompt"), \
             patch.object(pipeline, "embed", new=AsyncMock(return_value=[0.1])) as embedded:
            await pipeline.process_character_reply(message, character, input_saved=True)
        context = self.generate.await_args.args[1]
        self.assertIn("ห้องเงียบมา 24 นาที", context)
        self.assertIn("คุณกำลังเป็นคนเริ่มบทสนทนาเอง", context)
        # An opener needs its own memories, unlike a character answering another character.
        embedded.assert_awaited()
        # The quiet room adds no fake user message to the transcript.
        rows = self.store.get_history(10, session)
        self.assertEqual([row["role"] for row in rows], ["user", "model"])

    async def test_transcript_shows_which_message_each_reply_answers(self):
        chars = [
            Character("isla", "Isla", ("Isla",), Path("isla.md")),
            Character("rem", "Rem", ("Rem",), Path("rem.md")),
        ]
        names = {item.id: item.name for item in chars}
        rows = [
            {"role": "model", "character_id": "rem", "user_name": "Rem", "text": "กำลังชงชาค่ะ",
             "discord_message_id": "card-1", "reply_to_message_id": "msg-1"},
            {"role": "user", "user_name": "Yuuta", "user_id": "1", "text": "งั้นขอถ้วยนึง",
             "discord_message_id": "msg-2", "reply_to_message_id": "card-1"},
        ]
        lines, trailing, last_speaker = pipeline._transcript_with_replies(rows, names)
        self.assertIn('Yuuta (ตอบกลับ Rem: "กำลังชงชาค่ะ"): งั้นขอถ้วยนึง', lines)
        self.assertEqual(trailing, 1)
        self.assertEqual(last_speaker, "rem")

    async def test_character_history_carries_the_reply_arrow(self):
        session = "group:9"
        card = self.store.save_message("model", "ชาอุ่น ๆ ค่ะ", utc_now(), session, None, "Rem",
                                       None, None, "rem", discord_message_id="card-1")
        self.assertIsNotNone(card)
        self.store.save_message("user", "ขอบใจนะ", utc_now(), session, "1", "Yuuta", None, None,
                                reply_to_message_id="card-1", media_summary="ภาพถ้วยชา")
        message = {"user_id": "1", "user": "Yuuta", "text": "ขอบใจนะ", "session_key": session,
                   "timestamp": utc_now()}
        character = Character("isla", "Isla", ("Isla",), Path("isla.md"))
        with patch.object(pipeline, "load_characters", return_value=[character]), \
             patch.object(pipeline, "load_character_prompt", return_value="prompt"):
            await pipeline.process_character_reply(message, character)
        context = self.generate.await_args.args[1]
        self.assertIn('Yuuta [Discord User ID: 1] (ตอบกลับ Rem: "ชาอุ่น ๆ ค่ะ"): ขอบใจนะ', context)
        self.assertIn("[แนบ: ภาพถ้วยชา]", context)

    async def test_continuation_picks_the_character_the_line_points_at(self):
        chars = [
            Character("isla", "Isla", ("Isla",), Path("isla.md")),
            Character("rem", "Rem", ("Rem",), Path("rem.md")),
        ]
        speaker = chars[1]
        with patch.object(pipeline, "load_characters", return_value=chars), \
             patch.object(pipeline, "decide_speakers",
                          new=AsyncMock(return_value={"isla": 0.88})) as decision:
            chosen = await pipeline.decide_next_speaker(speaker, "ไอล่าว่าไงบ้าง", "group:9")
        self.assertEqual(chosen.id, "isla")
        self.assertNotIn("rem", decision.await_args.args[1])

    async def test_continuation_ends_when_nobody_is_interested(self):
        chars = [
            Character("isla", "Isla", ("Isla",), Path("isla.md")),
            Character("rem", "Rem", ("Rem",), Path("rem.md")),
        ]
        with patch.object(pipeline, "load_characters", return_value=chars), \
             patch.object(pipeline, "decide_speakers", new=AsyncMock(return_value={"isla": 0.2})):
            self.assertIsNone(await pipeline.decide_next_speaker(chars[1], "พอแล้วค่ะ", "group:9"))

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
        # A character brings its own memories to another character's line too.
        pipeline.embed.assert_awaited()

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
