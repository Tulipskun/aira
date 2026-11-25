import unittest

from aira.register_commands import ISLA_COMMAND, merge_commands


class RegisterCommandTests(unittest.TestCase):
    def test_registration_replaces_only_isla_command(self):
        existing = [
            {"id": "old-isla", "name": "isla", "description": "old"},
            {"id": "other-id", "application_id": "app", "version": "1", "name": "other",
             "description": "Keep me", "options": []},
            {"id": "third-id", "name": "another", "description": "also keep"},
        ]
        result = merge_commands(existing)
        self.assertEqual([x["name"] for x in result], ["other", "another", "isla"])
        self.assertEqual(result[0]["description"], "Keep me")
        self.assertNotIn("id", result[0])
        self.assertEqual(result[-1], ISLA_COMMAND)

    def test_does_not_duplicate_isla_when_already_registered(self):
        result = merge_commands([ISLA_COMMAND, {"name": "unrelated", "description": "retain"}])
        self.assertEqual(sum(command["name"] == "isla" for command in result), 1)
        self.assertIn("unrelated", [command["name"] for command in result])

    def test_all_slash_command_descriptions_meet_discord_limit(self):
        self.assertLessEqual(len(ISLA_COMMAND["description"]), 100)
        for command in ISLA_COMMAND["options"]:
            self.assertLessEqual(len(command["name"]), 32)
            self.assertLessEqual(len(command["description"]), 100)


if __name__ == "__main__":
    unittest.main()
