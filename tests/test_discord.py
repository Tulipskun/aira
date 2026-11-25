import asyncio
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import discord

from aira.discord_app import AiraBot, PanelView, build_footer, _rps_outcome
from aira.characters import Character


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

    def test_footer_shows_emotion_only_without_relationship_scores(self):
        footer = build_footer("ดีใจ")
        self.assertIn("ดีใจ", footer)
        self.assertNotIn("xp", footer.lower())
        self.assertNotIn("friend", footer.lower())
        self.assertEqual(build_footer(""), "")


    def test_every_character_embed_keeps_mood_color_and_expression_image(self):
        async def run_test():
            with tempfile.TemporaryDirectory() as directory:
                image_dir = Path(directory) / "rem"
                image_dir.mkdir()
                image_path = image_dir / "smile.png"
                image_path.write_bytes(b"image")
                character = Character("rem", "Rem", ("Rem",), Path("rem.md"), avatar_url="https://example.com/rem.png")
                webhook = SimpleNamespace(send=AsyncMock(return_value=SimpleNamespace(id=456)))
                channel = SimpleNamespace()
                last = {"user_id": "1", "user": "Alice", "channel_id": "9",
                        "message_id": "10", "session_key": "group:9"}
                bot = AiraBot()
                try:
                    with patch("aira.discord_app.config.images_dir", Path(directory)), \
                         patch.object(bot, "_character_webhook", new=AsyncMock(return_value=webhook)):
                        await bot._send_character_output(channel, {
                            "character": character, "text": "สวัสดี", "mood": "ดีใจ",
                            "color": 0x12ABEF, "image": "smile.png", "character_turn": False,
                        }, last, "batch")
                    kwargs = webhook.send.await_args.kwargs
                    embed = kwargs["embed"]
                    self.assertEqual(embed.colour.value, 0x12ABEF)
                    self.assertIn("ดีใจ", embed.footer.text)
                    self.assertIn("attachment://smile.png", embed.image.url)
                    self.assertEqual(kwargs["files"][0].filename, "smile.png")
                    self.assertEqual(kwargs["avatar_url"], "https://example.com/rem.png")
                    self.assertNotIn("xp", embed.footer.text.lower())
                    for file in kwargs.get("files", []):
                        file.close()
                finally:
                    await bot.close()
        asyncio.run(run_test())

    def test_autonomous_channel_guard_returns_wait_instead_of_dropping_conversation(self):
        bot = AiraBot()
        try:
            from collections import deque
            bot.autonomous_history["9"] = deque([100.0, 101.0, 102.0, 103.0])
            with patch("aira.discord_app.time.monotonic", return_value=104.0):
                self.assertAlmostEqual(bot._autonomous_wait_seconds("9"), 296.0)
            with patch("aira.discord_app.time.monotonic", return_value=405.0):
                self.assertEqual(bot._autonomous_wait_seconds("9"), 0.0)
        finally:
            asyncio.run(bot.close())


    def test_autonomous_worker_resumes_the_next_speaker_and_finishes_naturally(self):
        async def run_test():
            import time
            import aira.discord_app as app
            from aira.characters import load_characters
            from aira.store import Store
            with tempfile.TemporaryDirectory() as directory:
                test_store = Store(Path(directory) / "continuation.db")
                bot = AiraBot()
                chars = load_characters()
                rem = next(item for item in chars if item.id == "rem")
                payload = {
                    "created_at": time.time(), "batch_id": "batch-1",
                    "incoming": {"user_id": "1", "user": "Alice", "text": "คุยกัน",
                                 "timestamp": "2026-01-01T00:00:00Z", "session_key": "group:9",
                                 "speakers": [{"user_id": "1", "user": "Alice"}]},
                    "last": {"user_id": "1", "user": "Alice", "channel_id": "9",
                             "message_id": "10", "session_key": "group:9"},
                    "previous": {"character_id": "isla", "character_name": "Isla",
                                 "text": "Isla ตอบก่อนหน้า", "next_speaker_id": "rem"},
                    "pending_send": None,
                }
                test_store.save_autonomous_continuation("group:9", "9", payload)
                class FakeChannel:
                    pass
                fake_channel = FakeChannel()
                generated = AsyncMock(return_value={
                    "text": "Rem ตอบต่อ", "mood": "สงบ", "color": 0x123456,
                    "image": "", "rps": None, "next_speaker_id": "",
                })
                try:
                    with patch.object(app, "store", test_store), \
                         patch.object(app, "process_character_reply", new=generated), \
                         patch.object(app.live_token_budget, "available_tokens", return_value=50000), \
                         patch.object(app.discord, "TextChannel", FakeChannel), \
                         patch.object(app.discord, "Thread", FakeChannel), \
                         patch.object(bot, "get_channel", return_value=fake_channel), \
                         patch.object(bot, "_autonomous_wait_seconds", return_value=0), \
                         patch.object(bot, "_send_character_output", new=AsyncMock()) as send:
                        await bot._run_autonomous_continuation("group:9")
                    generated.assert_awaited_once()
                    self.assertEqual(generated.await_args.args[1].id, "rem")
                    self.assertEqual(generated.await_args.args[0]["text"], "Isla ตอบก่อนหน้า")
                    send.assert_awaited_once()
                    sent = send.await_args.args[1]
                    self.assertEqual(sent["text"], "Rem ตอบต่อ")
                    self.assertEqual(test_store.autonomous_continuation_count(), 0)
                finally:
                    await bot.close()
                    test_store.close()

        asyncio.run(run_test())

    def test_rps(self):
        self.assertIn("Isla ชนะ", _rps_outcome("rock", "scissors", "Alice"))
        self.assertIn("เสมอ", _rps_outcome("paper", "paper", "Alice"))


if __name__ == "__main__":
    unittest.main()
