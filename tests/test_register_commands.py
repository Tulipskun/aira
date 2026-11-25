import unittest

from aira.register_commands import AIRA_COMMAND, merge_commands


class RegisterCommandTests(unittest.TestCase):
    def test_registration_replaces_all_commands_with_only_aira(self):
        existing = [
            {"id": "old-isla", "name": "isla", "description": "old"},
            {"id": "other-id", "name": "other", "description": "remove"},
        ]
        self.assertEqual(merge_commands(existing), [AIRA_COMMAND])

    def test_command_name_is_aira(self):
        self.assertEqual(AIRA_COMMAND["name"], "aira")
        self.assertEqual(AIRA_COMMAND["type"], 1)
        self.assertLessEqual(len(AIRA_COMMAND["description"]), 100)


if __name__ == "__main__":
    unittest.main()
