import asyncio
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from aira import gemini
from aira.token_budget import SlidingWindowTokenBudget


class FakeLiveSession:
    def __init__(self, messages):
        self.messages = messages
        self.sent = []

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return False

    async def send_client_content(self, **kwargs):
        self.sent.append(kwargs)

    async def receive(self):
        for message in self.messages:
            yield message


class FakeLive:
    def __init__(self, messages):
        self.messages = messages
        self.calls = []
        self.sessions = []

    def connect(self, **kwargs):
        self.calls.append(kwargs)
        session = FakeLiveSession(self.messages)
        self.sessions.append(session)
        return session


class GeminiRequestTests(unittest.TestCase):
    def test_live_request_uses_audio_transcription_and_preserves_memory_context_and_json_schema(self):
        server_content = SimpleNamespace(
            model_turn=SimpleNamespace(parts=[SimpleNamespace(text=None)]),
            output_transcription=SimpleNamespace(text='{"Isla":"Hello"}'),
            turn_complete=True,
        )
        live = FakeLive([SimpleNamespace(server_content=server_content)])
        fake_client = SimpleNamespace(aio=SimpleNamespace(live=live))
        schema = {"type": "object", "properties": {"Isla": {"type": "string"}}}
        with (
            patch.object(gemini, "_live_client", return_value=fake_client),
            patch.object(gemini, "_model_input_limit", return_value=131072),
            patch.object(gemini, "live_token_budget", SlidingWindowTokenBudget(limit=1_000_000)),
        ):
            output = asyncio.run(gemini.generate_text(
                "gemini1", "hello\nความทรงจำที่ค้นพบ: Alice likes tea", "system", schema=schema,
            ))
        self.assertEqual(output, '{"Isla":"Hello"}')
        request = live.calls[0]
        self.assertEqual(request["model"], "gemini-3.8-live")
        self.assertEqual(request["config"].response_modalities, ["AUDIO"])
        self.assertIsInstance(request["config"].output_audio_transcription, gemini.types.AudioTranscriptionConfig)
        self.assertTrue(request["config"].system_instruction.startswith("system"))
        self.assertIsNone(request["config"].generation_config)
        compression = request["config"].context_window_compression
        self.assertEqual(compression.trigger_tokens, 100_000)
        self.assertEqual(compression.sliding_window.target_tokens, 80_000)
        self.assertIsNone(request["config"].session_resumption)
        self.assertIn('"type":"object"', request["config"].system_instruction)
        self.assertIn("JSON", request["config"].system_instruction)
        sent = live.sessions[0].sent[0]["turns"]
        self.assertIn("hello", sent.parts[0].text)
        self.assertIn("Alice likes tea", sent.parts[0].text)


    def test_generate_json_retries_a_truncated_transcription(self):
        schema = {"type": "object", "properties": {"Isla": {"type": "string"}}}

        class SequentialLive:
            def __init__(self, sessions):
                self.sessions = sessions
                self.calls = []

            def connect(self, **kwargs):
                self.calls.append(kwargs)
                return FakeLiveSession(self.sessions[len(self.calls) - 1])

        def message(text):
            return SimpleNamespace(server_content=SimpleNamespace(
                model_turn=SimpleNamespace(parts=[SimpleNamespace(text=None)]),
                output_transcription=SimpleNamespace(text=text),
                turn_complete=True,
            ))

        live = SequentialLive([[message('{"Isla": "Hel')], [message('{"Isla": "Hello"}')]])
        fake_client = SimpleNamespace(aio=SimpleNamespace(live=live))
        with (
            patch.object(gemini, "_live_client", return_value=fake_client),
            patch.object(gemini, "_model_input_limit", return_value=131072),
            patch.object(gemini, "live_token_budget", SlidingWindowTokenBudget(limit=1_000_000)),
        ):
            parsed = asyncio.run(gemini.generate_json("gemini1", "hello", "system", schema=schema))
        self.assertEqual(parsed, {"Isla": "Hello"})
        self.assertEqual(len(live.calls), 2)

    def test_generate_json_skips_the_retry_when_a_newer_message_is_waiting(self):
        schema = {"type": "object", "properties": {"Isla": {"type": "string"}}}
        server_content = SimpleNamespace(
            model_turn=SimpleNamespace(parts=[SimpleNamespace(text=None)]),
            output_transcription=SimpleNamespace(text='{"Isla": "Hel'),
            turn_complete=True,
        )
        live = FakeLive([SimpleNamespace(server_content=server_content)])
        fake_client = SimpleNamespace(aio=SimpleNamespace(live=live))
        with (
            patch.object(gemini, "_live_client", return_value=fake_client),
            patch.object(gemini, "_model_input_limit", return_value=131072),
            patch.object(gemini, "live_token_budget", SlidingWindowTokenBudget(limit=1_000_000)),
        ):
            parsed = asyncio.run(gemini.generate_json(
                "gemini1", "hello", "system", schema=schema, retry_guard=lambda: True))
        self.assertIsNone(parsed)
        # The queued message owns the next turn, so the stale attempt is not repeated.
        self.assertEqual(len(live.calls), 1)

    def test_truncated_character_answer_keeps_the_spoken_reply(self):
        truncated = '{"reply": "สวัสดีค่ะ ยินดีต้อนรับนะคะ", "summary": "ต้'
        server_content = SimpleNamespace(
            model_turn=SimpleNamespace(parts=[SimpleNamespace(text=None)]),
            output_transcription=SimpleNamespace(text=truncated),
            turn_complete=True,
        )
        live = FakeLive([SimpleNamespace(server_content=server_content)])
        fake_client = SimpleNamespace(aio=SimpleNamespace(live=live))
        with (
            patch.object(gemini, "_live_client", return_value=fake_client),
            patch.object(gemini, "_model_input_limit", return_value=131072),
            patch.object(gemini, "live_token_budget", SlidingWindowTokenBudget(limit=1_000_000)),
        ):
            output = asyncio.run(gemini.generate_character_reply("system", "context"))
        self.assertEqual(output["reply"], "สวัสดีค่ะ ยินดีต้อนรับนะคะ")
        self.assertEqual(output["mood"], "")
        self.assertIsNone(output["color"])
        self.assertEqual(len(live.calls), 2)

    def test_prose_only_answer_is_kept_when_the_json_never_started(self):
        prose = 'ไม่ต้องกังวลนะคะ ฉันอยู่ตรงนี้นะ'
        server_content = SimpleNamespace(
            model_turn=SimpleNamespace(parts=[SimpleNamespace(text=None)]),
            output_transcription=SimpleNamespace(text=prose),
            turn_complete=True,
        )
        live = FakeLive([SimpleNamespace(server_content=server_content)])
        fake_client = SimpleNamespace(aio=SimpleNamespace(live=live))
        with (
            patch.object(gemini, "_live_client", return_value=fake_client),
            patch.object(gemini, "_model_input_limit", return_value=131072),
            patch.object(gemini, "live_token_budget", SlidingWindowTokenBudget(limit=1_000_000)),
        ):
            output = asyncio.run(gemini.generate_character_reply("system", "context"))
        self.assertEqual(output["reply"], prose)

    def test_json_like_output_without_a_finished_reply_is_never_published(self):
        # Looks like JSON but no complete reply field: nothing usable may reach Discord.
        broken = '{"summary": "x", "mood": kom'
        server_content = SimpleNamespace(
            model_turn=SimpleNamespace(parts=[SimpleNamespace(text=None)]),
            output_transcription=SimpleNamespace(text=broken),
            turn_complete=True,
        )
        live = FakeLive([SimpleNamespace(server_content=server_content)])
        fake_client = SimpleNamespace(aio=SimpleNamespace(live=live))
        with (
            patch.object(gemini, "_live_client", return_value=fake_client),
            patch.object(gemini, "_model_input_limit", return_value=131072),
            patch.object(gemini, "live_token_budget", SlidingWindowTokenBudget(limit=1_000_000)),
        ):
            with self.assertRaises(ValueError):
                asyncio.run(gemini.generate_character_reply("system", "context"))

    def test_embedding_2_uses_query_and_document_instruction_prefixes(self):
        captured = []
        class Models:
            async def embed_content(self, **kwargs):
                captured.append(kwargs)
                return SimpleNamespace(embeddings=[SimpleNamespace(values=[0.1, 0.2])])
        fake = SimpleNamespace(aio=SimpleNamespace(models=Models()))
        with patch.object(gemini, "_client", return_value=fake), \
             patch.object(gemini, "_keys", return_value=["key"]), \
             patch.object(gemini.config, "embedding_dimension", 2):
            query = asyncio.run(gemini.embed("ใครชอบชา", "query"))
            document = asyncio.run(gemini.embed("Alice ชอบชา", "document"))
        self.assertEqual(query, [0.1, 0.2])
        self.assertEqual(document, [0.1, 0.2])
        self.assertEqual(captured[0]["contents"], "task: search result | query: ใครชอบชา")
        self.assertEqual(captured[1]["contents"], "title: none | text: Alice ชอบชา")
        self.assertEqual(captured[0]["config"].output_dimensionality, 2)

    def test_default_text_models_use_gemini_38_live_for_both_stages(self):
        import tempfile
        from pathlib import Path
        import aira.config as config_module
        with tempfile.TemporaryDirectory() as directory:
            settings_path = Path(directory) / "settings.json"
            with patch.object(config_module, "SETTINGS_PATH", settings_path):
                cfg = config_module.Config()
                self.assertEqual(cfg.gemini1_model, "gemini-3.8-live")
                self.assertEqual(cfg.gemini2_model, "gemini-3.8-live")

    def test_legacy_default_models_are_upgraded_but_custom_models_are_preserved(self):
        import json
        import tempfile
        from pathlib import Path
        import aira.config as config_module
        with tempfile.TemporaryDirectory() as directory:
            settings_path = Path(directory) / "settings.json"
            settings_path.write_text(json.dumps({
                "gemini1Model": "gemini-3.8-flash",
                "gemini2Model": "gemini-3.8-flash",
            }), encoding="utf-8")
            with patch.object(config_module, "SETTINGS_PATH", settings_path):
                cfg = config_module.Config()
                self.assertEqual(cfg.gemini1_model, "gemini-3.8-live")
                self.assertEqual(cfg.gemini2_model, "gemini-3.8-live")
            settings_path.write_text(json.dumps({
                "gemini1Model": "custom-model-a", "gemini2Model": "custom-model-b",
            }), encoding="utf-8")
            with patch.object(config_module, "SETTINGS_PATH", settings_path):
                cfg = config_module.Config()
                self.assertEqual(cfg.gemini1_model, "custom-model-a")
                self.assertEqual(cfg.gemini2_model, "custom-model-b")

    def test_both_default_stages_use_gemini_38_live(self):
        with patch.object(gemini.config, "gemini1_model", "gemini-3.8-live"):
            self.assertEqual(gemini.config.gemini1_model, "gemini-3.8-live")
        with patch.object(gemini.config, "gemini2_model", "gemini-3.8-live"):
            self.assertEqual(gemini.config.gemini2_model, "gemini-3.8-live")


    def test_key_pool_is_stage_specific(self):
        with patch.object(gemini.config, "gemini_keys", ["shared"]):
            with patch.object(gemini.config, "gemini1_keys", ["one", "two"]):
                with patch.object(gemini.config, "gemini2_keys", []):
                    self.assertEqual(gemini._keys("gemini1"), ["one", "two"])
                    self.assertEqual(gemini._keys("gemini2"), ["shared"])

    def test_character_reply_forwards_media_and_memory_tool_context(self):
        server_content = SimpleNamespace(
            model_turn=SimpleNamespace(parts=[SimpleNamespace(text=None)]),
            output_transcription=SimpleNamespace(text='{"reply":"Hello","memory":"","relationship":"same"}'),
            turn_complete=True,
        )
        live = FakeLive([SimpleNamespace(server_content=server_content)])
        fake_client = SimpleNamespace(aio=SimpleNamespace(live=live))
        media = [{"type": "image", "data": "aGVsbG8=", "mime_type": "image/png"}]
        with (
            patch.object(gemini, "_live_client", return_value=fake_client),
            patch.object(gemini, "_model_input_limit", return_value=131072),
            patch.object(gemini, "live_token_budget", SlidingWindowTokenBudget(limit=1_000_000)),
        ):
            result = asyncio.run(gemini.generate_character_reply(
                "character prompt", "context\nMemory: Alice likes tea", media,
                {"user_id": "42", "user_name": "Alice", "turn_id": "t1"},
            ))
        self.assertEqual(result["reply"], "Hello")
        sent = live.sessions[0].sent[0]["turns"]
        self.assertEqual(sent.parts[1].inline_data.mime_type, "image/png")
        self.assertIn("Alice likes tea", sent.parts[0].text)



    def test_invalid_character_json_is_never_returned_as_user_reply(self):
        async def fake_generate(*args, **kwargs):
            return '```json\n{"reply":"", "summary":"bad" "next_speaker_id":"bocchi"}\n```'
        with patch.object(gemini, "generate_text", side_effect=fake_generate):
            with self.assertRaisesRegex(ValueError, "raw output was not sent"):
                asyncio.run(gemini.generate_character_reply("prompt", "context"))

    def test_expression_image_catalogs_are_isolated_per_character(self):
        import tempfile
        from pathlib import Path
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "isla").mkdir()
            (root / "isla" / "isla_face.jpg").write_bytes(b"isla")
            (root / "rem").mkdir()
            (root / "rem" / "rem_smile.png").write_bytes(b"rem")
            (root / "bocchi").mkdir()
            (root / "bocchi" / "bocchi_nervous.webp").write_bytes(b"bocchi")
            with patch.object(gemini.config, "images_dir", root):
                self.assertEqual(gemini._image_names("isla"), ["isla_face.jpg"])
                self.assertEqual(gemini._image_names("rem"), ["rem_smile.png"])
                self.assertEqual(gemini._image_names("bocchi"), ["bocchi_nervous.webp"])
                self.assertEqual(gemini._normalize_image("isla_face.jpg", "rem"), "")
                self.assertEqual(gemini._normalize_image("rem_smile.png", "rem"), "rem_smile.png")
                self.assertIn("rem_smile.png", gemini._image_catalog_prompt("rem"))
                self.assertNotIn("isla_face.jpg", gemini._image_catalog_prompt("rem"))

    def test_shared_character_reply_parses_emotion_color_and_expression_image(self):
        async def fake_generate(stage, prompt, system, **kwargs):
            self.assertEqual(stage, "gemini1")
            required = kwargs["schema"]["required"]
            self.assertIn("mood", required)
            self.assertIn("color", required)
            self.assertIn("select_image", required)
            return ('{"reply":"ยินดีที่ได้คุย","summary":"ทักทาย","memory":"",'
                    '"relationship":"เริ่มสนิทกัน","character_relationships":[],"next_speaker_id":"",'
                    '"mood":"มีความสุข","color":"#12ABEF","select_image":"smile.png",'
                    '"add_facts":[{"text":"Alice ชอบชา","owner_user_id":"123",'
                    '"confirmed_by_owner":true}],"add_nicknames":["คนรักชา"]}')
        with patch.object(gemini, "generate_text", side_effect=fake_generate), \
             patch.object(gemini, "_image_names", return_value=["smile.png"]):
            result = asyncio.run(gemini.generate_character_reply("prompt", "context"))
        self.assertEqual(result["reply"], "ยินดีที่ได้คุย")
        self.assertEqual(result["mood"], "มีความสุข")
        self.assertEqual(result["color"], 0x12ABEF)
        self.assertEqual(result["image"], "smile.png")
        self.assertEqual(result["facts"], [{"text": "Alice ชอบชา", "owner_user_id": "123",
                                          "confirmed_by_owner": True, "replaces_fact": ""}])
        self.assertEqual(result["nicknames"], ["คนรักชา"])

    def test_reply_parser_reads_directional_character_relationships(self):
        parsed = gemini.parse_reply(
            '{"Isla":"สวัสดี","summery":"คุยกับ Nova",'
            '"relationships":[{"target_character_id":"nova","relationship":"ไว้ใจ Nova"}]}'
        )
        self.assertEqual(parsed["relationships"], [
            {"target_character_id": "nova", "relationship": "ไว้ใจ Nova"},
        ])

if __name__ == "__main__":
    unittest.main()
