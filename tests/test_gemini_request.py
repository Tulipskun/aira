import asyncio
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from aira import gemini, thought_signatures


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
    def setUp(self):
        self.old_pool = list(thought_signatures._pool)
        self.old_cursor = thought_signatures._cursor
        thought_signatures._pool[:] = ["test-signature"]
        thought_signatures._cursor = 0

    def tearDown(self):
        thought_signatures._pool[:] = self.old_pool
        thought_signatures._cursor = self.old_cursor

    def test_live_request_uses_audio_transcription_and_preserves_memory_context_and_json_schema(self):
        server_content = SimpleNamespace(
            model_turn=SimpleNamespace(parts=[SimpleNamespace(text=None)]),
            output_transcription=SimpleNamespace(text='{"Isla":"Hello"}'),
            turn_complete=True,
        )
        live = FakeLive([SimpleNamespace(server_content=server_content)])
        fake_client = SimpleNamespace(aio=SimpleNamespace(live=live))
        temporary = thought_signatures.fake_tool_call_result("search_memory", {"user": "Alice"}, {"memories": []})
        schema = {"type": "object", "properties": {"Isla": {"type": "string"}}}
        with patch.object(gemini, "_live_client", return_value=fake_client):
            output = asyncio.run(gemini.generate_text(
                "gemini1", "hello", "system", schema=schema, temporary_steps=temporary,
            ))
        self.assertEqual(output, '{"Isla":"Hello"}')
        request = live.calls[0]
        self.assertEqual(request["model"], "gemini-3.8-live")
        self.assertEqual(request["config"].response_modalities, ["AUDIO"])
        self.assertIsInstance(request["config"].output_audio_transcription, gemini.types.AudioTranscriptionConfig)
        self.assertTrue(request["config"].system_instruction.startswith("system"))
        self.assertIsNone(request["config"].generation_config)
        self.assertIn('"type":"object"', request["config"].system_instruction)
        self.assertIn("JSON", request["config"].system_instruction)
        sent = live.sessions[0].sent[0]["turns"]
        self.assertIn("hello", sent.parts[0].text)
        self.assertIn("ผลจาก search_memory", sent.parts[1].text)


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
        tool_steps = thought_signatures.fake_tool_call_result("search_character_memory", {}, {"memories": []})
        with patch.object(gemini, "_live_client", return_value=fake_client):
            result = asyncio.run(gemini.generate_character_reply(
                "character prompt", "context", media, tool_steps,
                {"user_id": "42", "user_name": "Alice", "turn_id": "t1"},
            ))
        self.assertEqual(result["reply"], "Hello")
        sent = live.sessions[0].sent[0]["turns"]
        self.assertEqual(sent.parts[1].inline_data.mime_type, "image/png")
        self.assertIn("ผลจาก search_character_memory", sent.parts[2].text)

    def test_speaker_scheduler_can_choose_silence_or_one_secondary_actor(self):
        captured = {}
        async def fake_generate(stage, prompt, system, **kwargs):
            captured.update({"stage": stage, "prompt": prompt, "system": system, **kwargs})
            return '{"speakers":["nova"]}'
        history = [{"role": "model", "user_name": "Isla", "text": "เรื่องนั้นน่าสนใจ"}]
        with patch.object(gemini, "generate_text", side_effect=fake_generate):
            result = asyncio.run(gemini.choose_character_speakers(
                "วันนี้อากาศดี", "Alice",
                [{"id": "isla", "name": "Isla", "aliases": ["Isla"]},
                 {"id": "nova", "name": "Nova", "aliases": ["Nova"]}],
                recent_history=history,
            ))
        self.assertEqual(result, ["nova"])
        self.assertEqual(captured["stage"], "gemini2")
        self.assertIn("เงียบ", captured["prompt"])
        self.assertIn("ไม่จำเป็นต้องมี Isla", captured["prompt"])
        self.assertIn("ตัวละครเสริมสองตัวพร้อมกัน", captured["prompt"])
        self.assertIn("Isla: เรื่องนั้นน่าสนใจ", captured["prompt"])
        self.assertEqual(captured["schema"]["required"], ["speakers"])

    def test_reply_parser_reads_directional_character_relationships(self):
        parsed = gemini.parse_reply(
            '{"Isla":"สวัสดี","summery":"คุยกับ Nova",'
            '"relationships":[{"target_character_id":"nova","relationship":"ไว้ใจ Nova"}]}'
        )
        self.assertEqual(parsed["relationships"], [
            {"target_character_id": "nova", "relationship": "ไว้ใจ Nova"},
        ])

    def test_analyze_turn_uses_user_id_and_partner_in_prompt(self):
        captured = {}
        async def fake_generate(stage, prompt, system, **kwargs):
            captured.update({"stage": stage, "prompt": prompt, "system": system, **kwargs})
            return '{"affinity":0,"is_flirt":false,"select_image":"none"}'
        with patch.object(gemini, "generate_text", side_effect=fake_generate):
            result = asyncio.run(gemini.analyze_turn(
                "turn", "Alice", "stranger", 0, 0, user_id="123",
                debug_context={"user_id": "123"},
            ))
        self.assertEqual(captured["stage"], "gemini2")
        self.assertIn("Alice", captured["system"])
        self.assertIn("is_flirt", captured["schema"]["required"])
        self.assertEqual(result["affinity"], 0)

    def test_state_schema_requires_relationship_signals_by_bond(self):
        self.assertIn("is_flirt", gemini._state_schema("stranger")["required"])
        self.assertIn("approve_lover", gemini._state_schema("crush")["required"])
        self.assertIn("approve_soulmate", gemini._state_schema("lover")["required"])
        self.assertNotIn("is_flirt", gemini._state_schema("family")["required"])


if __name__ == "__main__":
    unittest.main()
