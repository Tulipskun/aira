import asyncio
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import discord

from aira.discord_app import AiraBot, PanelView, build_footer, _rps_outcome


class ChannelSelectInteractionTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.bot = AiraBot()
        self.view = PanelView(self.bot)
        self.select = next(item for item in self.view.children if isinstance(item, discord.ui.ChannelSelect))
        self.bot.is_owner = lambda user_id: True
        self.bot.panel_embed = lambda: discord.Embed(title="updated")

    async def asyncTearDown(self):
        await self.bot.close()

    def make_interaction(self, permissions):
        channel = SimpleNamespace(
            id=987654,
            permissions_for=lambda member: permissions,
        )
        selected = SimpleNamespace(id=987654, resolve=lambda: channel)
        response = SimpleNamespace(defer=AsyncMock(), send_message=AsyncMock())
        followup = SimpleNamespace(send=AsyncMock())
        interaction = SimpleNamespace(
            user=SimpleNamespace(id=123),
            guild=SimpleNamespace(me=object()),
            response=response,
            followup=followup,
            edit_original_response=AsyncMock(),
        )
        return interaction, SimpleNamespace(values=[selected])

    async def test_channel_select_defers_before_saving_and_updates_panel(self):
        permissions = SimpleNamespace(view_channel=True, send_messages=True)
        interaction, select = self.make_interaction(permissions)
        self.select._values = select.values
        with patch('aira.discord_app.set_response_channel_id') as save:
            await self.select.callback(interaction)
        interaction.response.defer.assert_awaited_once_with()
        save.assert_called_once_with('987654')
        interaction.edit_original_response.assert_awaited_once()
        interaction.followup.send.assert_not_awaited()

    async def test_channel_select_resolves_app_command_channel_before_permission_check(self):
        permissions = SimpleNamespace(view_channel=True, send_messages=True)
        real_channel = SimpleNamespace(id=987654, permissions_for=lambda member: permissions)
        # This mirrors discord.py AppCommandChannel: it has resolve()/fetch(),
        # but deliberately does not expose permissions_for().
        selected = SimpleNamespace(id=987654, resolve=lambda: real_channel)
        interaction, _ = self.make_interaction(permissions)
        self.select._values = [selected]
        with patch('aira.discord_app.set_response_channel_id') as save:
            await self.select.callback(interaction)
        interaction.response.defer.assert_awaited_once_with()
        save.assert_called_once_with('987654')
        interaction.edit_original_response.assert_awaited_once()

    async def test_channel_select_fetches_channel_when_not_cached(self):
        permissions = SimpleNamespace(view_channel=True, send_messages=True)
        real_channel = SimpleNamespace(id=987654, permissions_for=lambda member: permissions)
        selected = SimpleNamespace(resolve=lambda: None, fetch=AsyncMock(return_value=real_channel), id=987654)
        interaction, _ = self.make_interaction(permissions)
        self.select._values = [selected]
        with patch('aira.discord_app.set_response_channel_id') as save:
            await self.select.callback(interaction)
        selected.fetch.assert_awaited_once()
        save.assert_called_once_with('987654')
        interaction.edit_original_response.assert_awaited_once()

    async def test_channel_select_defers_and_reports_missing_permissions(self):
        permissions = SimpleNamespace(view_channel=True, send_messages=False)
        interaction, select = self.make_interaction(permissions)
        self.select._values = select.values
        with patch('aira.discord_app.set_response_channel_id') as save:
            await self.select.callback(interaction)
        interaction.response.defer.assert_awaited_once_with()
        save.assert_not_called()
        interaction.followup.send.assert_awaited_once()
        interaction.edit_original_response.assert_not_awaited()


class DiscordTests(unittest.TestCase):
    def test_bot_registers_expected_slash_commands(self):
        bot = AiraBot()
        try:
            self.assertEqual([command.name for command in bot.tree.get_commands()], ["aira"])
            self.assertEqual(len(PanelView(bot).children), 5)
            self.assertEqual(bot.liveness.state()["shards"], {0: False})
            self.assertFalse(bot.liveness.state()["ok"])
            with patch.object(bot, "is_ready", return_value=True):
                self.assertEqual(bot.liveness.state()["shards"], {0: True})
                self.assertTrue(bot.liveness.state()["ok"])
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
