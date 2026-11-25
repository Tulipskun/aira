import re
import unittest

from aira.gemini import fill_partner, normalize_color, parse_reply


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
