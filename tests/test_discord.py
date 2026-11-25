import asyncio
import unittest

import discord

from aira.discord_app import AiraBot, PanelView, build_footer, _rps_outcome


class DiscordTests(unittest.TestCase):
    def test_bot_registers_expected_slash_commands(self):
        bot = AiraBot()
        try:
            group = next(command for command in bot.tree.get_commands() if command.name == "isla")
            self.assertEqual(
                {command.name for command in group.commands},
                {"join-group", "leave-group", "status", "leaderboard"},
            )
            self.assertEqual(len(PanelView(bot).children), 5)
            self.assertEqual([child.name for child in group.commands],
                             ["join-group", "leave-group", "status", "leaderboard"])
        finally:
            asyncio.run(bot.close())

    def test_private_and_group_footer(self):
        private = build_footer({"user_name": "Alice", "bond": "friend", "xp": 150}, "ดีใจ", True)
        group = build_footer({"user_name": "Alice", "bond": "friend", "xp": 150}, None, False)
        self.assertIn("Alice", private)
        self.assertIn("ดีใจ", private)
        self.assertIn("Alice", group)

    def test_rps(self):
        self.assertIn("Isla ชนะ", _rps_outcome("rock", "scissors", "Alice"))
        self.assertIn("เสมอ", _rps_outcome("paper", "paper", "Alice"))


if __name__ == "__main__":
    unittest.main()
