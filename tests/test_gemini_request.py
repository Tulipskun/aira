import asyncio
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from aira import gemini, thought_signatures


class FakeInteractions:
    def __init__(self, response):
        self.response = response
        self.calls = []

    async def create(self, **kwargs):
        self.calls.append(kwargs)
        return self.response


class GeminiRequestTests(unittest.TestCase):
    def setUp(self):
        self.old_pool = list(thought_signatures._pool)
        self.old_cursor = thought_signatures._cursor
        thought_signatures._pool[:] = ["test-signature"]
        thought_signatures._cursor = 0

    def tearDown(self):
        thought_signatures._pool[:] = self.old_pool
        thought_signatures._cursor = self.old_cursor

    def test_interactions_request_includes_context_and_json_response_format(self):
        response = SimpleNamespace(output_text='{"Isla":"Hello"}', steps=[])
        interactions = FakeInteractions(response)
        fake_client = SimpleNamespace(aio=SimpleNamespace(interactions=interactions))
        temporary = thought_signatures.fake_tool_call_result("search_memory", {"user": "Alice"}, {"memories": []})
        schema = {"type": "object", "properties": {"Isla": {"type": "string"}}}
        with patch.object(gemini, "_client", return_value=fake_client):
            output = asyncio.run(gemini.generate_text(
                "gemini1", "hello", "system", schema=schema, temporary_steps=temporary,
            ))
        self.assertEqual(output, '{"Isla":"Hello"}')
        request = interactions.calls[0]
        self.assertEqual(request["input"][0]["type"], "user_input")
        self.assertEqual([x["type"] for x in request["input"][1:]], ["thought", "function_call", "function_result"])
        self.assertEqual(request["response_format"]["mime_type"], "application/json")
        self.assertEqual(request["response_format"]["schema"], schema)
        self.assertFalse(request["store"])

    def test_default_text_models_use_gemini_38_flash_for_both_stages(self):
        import tempfile
        from pathlib import Path
        import aira.config as config_module
        with tempfile.TemporaryDirectory() as directory:
            settings_path = Path(directory) / "settings.json"
            with patch.object(config_module, "SETTINGS_PATH", settings_path):
                cfg = config_module.Config()
                self.assertEqual(cfg.gemini1_model, "gemini-3.8-flash")
                self.assertEqual(cfg.gemini2_model, "gemini-3.8-flash")

    def test_legacy_default_models_are_upgraded_but_custom_models_are_preserved(self):
        import json
        import tempfile
        from pathlib import Path
        import aira.config as config_module
        with tempfile.TemporaryDirectory() as directory:
            settings_path = Path(directory) / "settings.json"
            settings_path.write_text(json.dumps({
                "gemini1Model": "gemini-3.1-flash-lite",
                "gemini2Model": "gemini-3.5-flash-lite",
            }), encoding="utf-8")
            with patch.object(config_module, "SETTINGS_PATH", settings_path):
                cfg = config_module.Config()
                self.assertEqual(cfg.gemini1_model, "gemini-3.8-flash")
                self.assertEqual(cfg.gemini2_model, "gemini-3.8-flash")
            settings_path.write_text(json.dumps({
                "gemini1Model": "custom-model-a", "gemini2Model": "custom-model-b",
            }), encoding="utf-8")
            with patch.object(config_module, "SETTINGS_PATH", settings_path):
                cfg = config_module.Config()
                self.assertEqual(cfg.gemini1_model, "custom-model-a")
                self.assertEqual(cfg.gemini2_model, "custom-model-b")

    def test_interactions_use_configured_model_for_each_stage(self):
        response = SimpleNamespace(output_text="ok", steps=[])
        interactions = FakeInteractions(response)
        fake_client = SimpleNamespace(aio=SimpleNamespace(interactions=interactions))
        with patch.object(gemini, "_client", return_value=fake_client):
            with patch.object(gemini.config, "gemini1_model", "gemini-3.8-flash"):
                asyncio.run(gemini.generate_text("gemini1", "hello", "system"))
            with patch.object(gemini.config, "gemini2_model", "gemini-3.8-flash"):
                asyncio.run(gemini.generate_text("gemini2", "hello", "system"))
        self.assertEqual([call["model"] for call in interactions.calls],
                         ["gemini-3.8-flash", "gemini-3.8-flash"])

    def test_response_thought_signature_is_saved(self):
        response = SimpleNamespace(output_text="ok", steps=[
            SimpleNamespace(type="thought", signature="new-signature")
        ])
        interactions = FakeInteractions(response)
        fake_client = SimpleNamespace(aio=SimpleNamespace(interactions=interactions))
        with patch.object(gemini, "_client", return_value=fake_client):
            asyncio.run(gemini.generate_text("gemini1", "hello", "system"))
        self.assertIn("new-signature", thought_signatures._pool)

    def test_key_pool_is_stage_specific(self):
        with patch.object(gemini.config, "gemini_keys", ["shared"]):
            with patch.object(gemini.config, "gemini1_keys", ["one", "two"]):
                self.assertEqual(gemini._keys("gemini1"), ["one", "two"])
                self.assertEqual(gemini._keys("gemini2"), ["shared"])

    def test_character_reply_forwards_media_and_memory_tool_context(self):
        response = SimpleNamespace(output_text='{"reply":"Hello","memory":"","relationship":"same"}', steps=[])
        interactions = FakeInteractions(response)
        fake_client = SimpleNamespace(aio=SimpleNamespace(interactions=interactions))
        media = [{"type": "image", "data": "aGVsbG8=", "mime_type": "image/png"}]
        tool_steps = thought_signatures.fake_tool_call_result("search_character_memory", {}, {"memories": []})
        with patch.object(gemini, "_client", return_value=fake_client):
            result = asyncio.run(gemini.generate_character_reply(
                "character prompt", "context", media, tool_steps,
                {"user_id": "42", "user_name": "Alice", "turn_id": "t1"},
            ))
        self.assertEqual(result["reply"], "Hello")
        self.assertIn(media[0], interactions.calls[0]["input"][0]["content"])
        self.assertEqual([step["type"] for step in interactions.calls[0]["input"][1:]],
                         ["thought", "function_call", "function_result"])

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
