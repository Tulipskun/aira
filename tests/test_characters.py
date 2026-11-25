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
        self.assertEqual([x.id for x in selected], ["isla", "nova"])
        selected = resolve_character_speakers(chars, [], ["second", "nova"])
        self.assertEqual([x.id for x in selected], ["second"])
        selected = resolve_character_speakers(chars, [], ["nova", "isla"])
        self.assertEqual([x.id for x in selected], ["isla", "nova"])

    def test_every_character_including_isla_has_an_isolated_memory_namespace(self):
        self.assertEqual(character_session_key("group:9", "isla"), "group:9:character:isla")
        self.assertEqual(character_session_key("group:9", "nova"), "group:9:character:nova")


if __name__ == "__main__":
    unittest.main()
