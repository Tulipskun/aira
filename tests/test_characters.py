import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from aira.characters import Character, _validate, resolve_character_selection, find_mentioned_characters


class CharacterTests(unittest.TestCase):
    def test_prompt_path_must_stay_inside_repository(self):
        with self.assertRaises(ValueError):
            _validate({"id": "x", "name": "X", "promptFile": "../../etc/passwd"}, "x.json")

    def test_mentions_and_selection_are_deduplicated(self):
        isla = Character("isla", "Isla", ("Isla",), Path("isla.md"))
        nova = Character("nova", "Nova", ("Nova", "N"), Path("nova.md"))
        chars = [isla, nova]
        mentioned = find_mentioned_characters("Nova ช่วยหน่อย", chars)
        selected = resolve_character_selection(chars, mentioned, ["nova", "unknown"])
        self.assertEqual([x.id for x in selected], ["isla", "nova"])
        second = Character("second", "Second", ("Second",), Path("second.md"))
        selected = resolve_character_selection([isla, nova, second], [nova, second], ["second"])
        self.assertEqual([x.id for x in selected], ["isla", "nova"])
        selected = resolve_character_selection([isla, nova, second], [], ["second"])
        self.assertEqual([x.id for x in selected], ["isla", "second"])


if __name__ == "__main__":
    unittest.main()
