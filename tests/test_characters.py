import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from aira.characters import (
    Character, _validate, find_mentioned_characters, resolve_character_speakers,
    character_session_key,
)


class CharacterTests(unittest.TestCase):
    def test_approved_anime_characters_are_registered_with_distinct_personalities(self):
        from aira.characters import load_characters, load_character_prompt
        characters = {item.id: item for item in load_characters()}
        self.assertTrue({"isla", "rem", "bocchi", "origami"}.issubset(characters))
        self.assertEqual(characters["rem"].name, "Rem")
        self.assertEqual(characters["bocchi"].name, "Hitori Gotoh")
        self.assertEqual(characters["origami"].name, "Origami Tobiichi")
        self.assertIn("หน้าตาย", load_character_prompt(characters["origami"]))
        # The avatar URL is built from a frame that is really on disk, so a rebuild
        # of the image set cannot leave a dead URL behind.
        for character in characters.values():
            self.assertTrue(character.avatar_url.startswith("https://"))
            self.assertIn(f"/{character.id}/", character.avatar_url)
        rem_prompt = load_character_prompt(characters["rem"])
        bocchi_prompt = load_character_prompt(characters["bocchi"])
        self.assertIn("เด็ดเดี่ยว", rem_prompt)
        self.assertIn("ขี้อาย", bocchi_prompt)
        self.assertIn("ไม่ใช่ผู้ช่วยที่ต้องตอบทุกข้อความ", rem_prompt)
        self.assertIn("ไม่ใช่ผู้ช่วยที่ต้องตอบทุกข้อความ", bocchi_prompt)
        self.assertIn("ไม่ใช่ผู้ช่วยที่ต้องตอบทุกข้อความ",
                      load_character_prompt(characters["origami"]))

    def test_the_avatar_comes_from_a_frame_that_exists(self):
        character = _validate({"id": "rem", "name": "Rem", "promptFile": "prompts/rem.md",
                               "avatarFile": "rem_calm_06.jpg"}, "rem.json")
        self.assertTrue(character.avatar_url.endswith("/rem/rem_calm_06.jpg"))
        self.assertTrue(character.enabled)
        stale = _validate({"id": "rem", "name": "Rem", "promptFile": "prompts/rem.md",
                           "avatarFile": "rem_gone_99999.jpg"}, "rem.json")
        self.assertNotIn("rem_gone_99999.jpg", stale.avatar_url)
        with self.assertRaises(ValueError):
            _validate({"id": "rem", "name": "Rem", "promptFile": "prompts/rem.md",
                       "avatarFile": "../../etc/passwd"}, "rem.json")

    def test_prompt_path_must_stay_inside_repository(self):
        with self.assertRaises(ValueError):
            _validate({"id": "x", "name": "X", "promptFile": "../../etc/passwd"}, "x.json")

    def test_characters_may_speak_or_stay_silent(self):
        isla = Character("isla", "Isla", ("Isla",), Path("isla.md"))
        nova = Character("nova", "Nova", ("Nova", "N"), Path("nova.md"))
        second = Character("second", "Second", ("Second",), Path("second.md"))
        chars = [isla, nova, second]
        self.assertEqual(resolve_character_speakers(chars, [], []), [])
        mentioned = find_mentioned_characters("Nova ช่วยหน่อย", chars)
        selected = resolve_character_speakers(chars, mentioned, ["isla", "second"])
        self.assertEqual([x.id for x in selected], ["nova", "isla", "second"])
        selected = resolve_character_speakers(chars, [], ["second", "nova"])
        self.assertEqual([x.id for x in selected], ["second", "nova"])
        selected = resolve_character_speakers(chars, [], ["nova", "isla"])
        self.assertEqual([x.id for x in selected], ["nova", "isla"])
        rem = Character("rem", "Rem", ("Rem",), Path("rem.md"))
        bocchi = Character("bocchi", "Hitori Gotoh", ("Bocchi",), Path("bocchi.md"))
        selected = resolve_character_speakers([isla, rem, bocchi], [], ["rem", "bocchi"])
        self.assertEqual([x.id for x in selected], ["rem", "bocchi"])

    def test_every_character_including_isla_has_an_isolated_memory_namespace(self):
        self.assertEqual(character_session_key("group:9", "isla"), "group:9:character:isla")
        self.assertEqual(character_session_key("group:9", "nova"), "group:9:character:nova")


if __name__ == "__main__":
    unittest.main()
