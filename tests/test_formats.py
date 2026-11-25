import re
import unittest

from aira.gemini import _state_schema, fill_partner, normalize_color, parse_reply, parse_state, state_prompt_values


class FormatTests(unittest.TestCase):
    def test_reply_parser_supports_documented_capitalization(self):
        reply = parse_reply('{"Isla":"สวัสดี","summery":"ทักทาย","mood":"ดีใจ","color":"#F1C40F","rps":"paper"}')
        self.assertEqual(reply["text"], "สวัสดี")
        self.assertEqual(reply["summary"], "ทักทาย")
        self.assertEqual(reply["rps"], "paper")
        self.assertEqual(reply["color"], 0xF1C40F)

    def test_raw_text_fallback(self):
        reply = parse_reply("plain response")
        self.assertEqual(reply["text"], "plain response")
        self.assertFalse(reply["parsed"])

    def test_state_parser_limits_and_fact_owner(self):
        state = parse_state('{"affinity":5,"is_flirt":true,"add_facts":[{"text":"x","owner_user_id":"1","confirmed_by_owner":true}]}', "crush")
        self.assertEqual(state["affinity"], 10)
        self.assertTrue(state["is_flirt"])
        self.assertEqual(len(state["facts"]), 1)

    def test_romantic_signal_is_ignored_for_family(self):
        state = parse_state('{"affinity":-500,"is_flirt":true}', "family")
        self.assertFalse(state["is_flirt"])
        self.assertEqual(state["affinity"], -100)

    def test_partner_prompt_is_rendered(self):
        prompt = state_prompt_values("crush", 500, 5, "123", "Example User")
        self.assertIn("Example User", prompt)
        self.assertNotIn("{{partner}}", prompt)
        self.assertEqual(re.findall(r"{{\s*([A-Za-z0-9_.-]+)\s*}}", prompt), [])

    def test_state_schema_does_not_embed_dynamic_image_catalog(self):
        schema = _state_schema("crush")
        self.assertNotIn("enum", schema["properties"]["select_image"])
        self.assertIn("approve_lover", schema["required"])

    def test_partner_spacing_keeps_thai_word_boundaries(self):
        self.assertEqual(fill_partner("สวัสดี{{partner}}วันนี้", "Alice"), "สวัสดี Alice วันนี้")
        self.assertEqual(fill_partner("{{partner}}!", "Alice"), "Alice!")
        self.assertEqual(fill_partner("Hello {{partner}}, welcome", "Alice"), "Hello Alice, welcome")

    def test_colors(self):
        self.assertEqual(normalize_color("#f1c40f"), 0xF1C40F)
        self.assertEqual(normalize_color(0x123456), 0x123456)
        self.assertEqual(normalize_color("rgb(241, 196, 15)"), 0xF1C40F)
        self.assertEqual(normalize_color("#12345678"), 0x123456)
        self.assertEqual(normalize_color("red"), 0xED4245)
        self.assertIsNone(normalize_color("not a color"))


if __name__ == "__main__":
    unittest.main()
