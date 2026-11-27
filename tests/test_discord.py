import asyncio
import tempfile
import unittest
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import discord

from aira import discord_app
from aira.discord_app import AiraBot, PanelView, build_footer, _rps_outcome
from aira.characters import Character


class WebhookMessageTests(unittest.TestCase):
    def test_another_bot_is_part_of_the_room(self):
        from types import SimpleNamespace
        from aira.discord_app import _is_character_webhook
        other = SimpleNamespace(webhook_id=42, author=SimpleNamespace(name="Mee6"))
        ours = SimpleNamespace(webhook_id=43, author=SimpleNamespace(name="Aira Character (rem)"))
        plain_user = SimpleNamespace(webhook_id=None, author=SimpleNamespace(name="Yuuta"))
        self.assertFalse(_is_character_webhook(other))
        self.assertTrue(_is_character_webhook(ours))
        self.assertFalse(_is_character_webhook(plain_user))


class QuietHoursTests(unittest.IsolatedAsyncioTestCase):
    """The small hours stop the openings only; answering a person is untouched."""

    async def asyncSetUp(self):
        self.bot = AiraBot()

    async def asyncTearDown(self):
        await self.bot.close()

    def at(self, hour: int):
        return datetime(2026, 1, 1, hour, 30, tzinfo=ZoneInfo(discord_app.config.timezone))

    async def test_the_opener_is_held_back_between_two_and_five(self):
        with patch.object(discord_app.config, "idle_chat", True):
            for hour in (2, 3, 4):
                self.assertFalse(self.bot._may_open("group:1", self.at(hour)), hour)
            for hour in (1, 5, 9, 14, 23):
                self.assertTrue(self.bot._may_open("group:1", self.at(hour)), hour)

    async def test_a_turn_in_flight_or_a_queued_message_also_holds_it_back(self):
        self.bot.in_flight = 1
        with patch.object(discord_app.config, "idle_chat", True):
            self.assertFalse(self.bot._may_open("group:1", self.at(14)))
        self.bot.in_flight = 0
        with patch.object(discord_app.config, "idle_chat", True), \
             patch.object(self.bot.scheduler, "has_pending_session", return_value=True):
            self.assertFalse(self.bot._may_open("group:1", self.at(14)))

    async def test_answering_a_person_never_consults_the_small_hours(self):
        source = Path(discord_app.__file__).read_text()
        # One call site, inside the opener gate: the reply path cannot reach it.
        self.assertEqual(source.count("quiet_hours("), 1)
        gate = source[source.index("def _may_open"):source.index("def _idle_deadline")]
        self.assertIn("quiet_hours(now)", gate)
        reply = source[source.index("async def _process_batch"):]
        self.assertNotIn("quiet_hours", reply)


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
                    # The avatar belongs to the webhook itself; per-message overrides made
                    # Discord drop the avatar whenever its URL fetch failed.
                    self.assertNotIn("avatar_url", kwargs)
                    self.assertNotIn("xp", embed.footer.text.lower())
                    for file in kwargs.get("files", []):
                        file.close()
                finally:
                    await bot.close()
        asyncio.run(run_test())

    def test_character_webhook_uploads_the_whole_avatar_body(self):
        async def run_test():
            import aira.discord_app as app
            body = b"\x89PNG\r\n\x1a\n" + b"a" * 200_000

            class FakeResponse:
                headers = {"Content-Type": "image/png"}
                content_length = len(body)

                def raise_for_status(self):
                    return None

                async def read(self):
                    return body

            class FakeSession:
                def __init__(self, *args, **kwargs):
                    pass

                async def __aenter__(self):
                    return self

                async def __aexit__(self, *exc):
                    return False

                def get(self, url, allow_redirects=True):
                    class Context:
                        async def __aenter__(inner):
                            return FakeResponse()

                        async def __aexit__(inner, *exc):
                            return False

                    return Context()

            parent = MagicMock(spec=discord.TextChannel)
            parent.id = 9
            parent.guild = SimpleNamespace(me=SimpleNamespace(id=1))
            parent.permissions_for = lambda member: SimpleNamespace(manage_webhooks=True)
            parent.webhooks = AsyncMock(return_value=[])
            created = MagicMock()
            created.id = 42
            created.edit = AsyncMock(return_value=SimpleNamespace(id=42, avatar="hash"))
            parent.create_webhook = AsyncMock(return_value=created)
            character = Character("rem", "Rem", ("Rem",), Path("rem.md"),
                                  avatar_url="https://example.com/rem.png")
            bot = AiraBot()
            try:
                app.CHARACTER_WEBHOOKS.clear()
                app.CHARACTER_WEBHOOK_AVATARS.clear()
                with patch.object(app.aiohttp, "ClientSession", FakeSession):
                    webhook = await bot._character_webhook(parent, character)
                # A partial read used to send a truncated image, so Discord kept the old avatar.
                self.assertEqual(created.edit.await_args.kwargs["avatar"], body)
                self.assertIs(webhook, created.edit.return_value)
            finally:
                await bot.close()
        asyncio.run(run_test())

    def test_character_replies_wait_for_their_ten_second_beat(self):
        async def run_test():
            import time
            import aira.discord_app as app
            from aira.store import Store

            class Beat(Exception):
                pass

            class FakeChannel:
                pass

            with tempfile.TemporaryDirectory() as directory:
                test_store = Store(Path(directory) / "chat-beat.db")
                bot = AiraBot()
                test_store.save_autonomous_continuation("group:9", "9", {
                    "created_at": time.time(), "batch_id": "batch-1", "hops": 1,
                    "incoming": {"user_id": "1", "user": "Alice", "text": "คุยกัน",
                                 "timestamp": "2026-01-01T00:00:00Z", "session_key": "group:9",
                                 "speakers": [{"user_id": "1", "user": "Alice"}]},
                    "last": {"user_id": "1", "user": "Alice", "channel_id": "9",
                             "message_id": "10", "session_key": "group:9"},
                    "previous": {"character_id": "isla", "character_name": "Isla",
                                 "text": "Isla ตอบ", "next_speaker_id": "rem"},
                    "pending_send": None,
                })
                generated = AsyncMock(return_value={
                    "character": None, "text": "Rem ตอบต่อ", "mood": "", "color": None,
                    "image": "", "rps": None, "next_speaker_id": "",
                })
                send = AsyncMock()
                observed = AsyncMock(side_effect=Beat)
                try:
                    bot.last_ai_turn_at["9"] = time.time()
                    with patch.object(app, "store", test_store), \
                         patch.object(app, "process_character_reply", new=generated), \
                         patch.object(bot, "get_channel", return_value=FakeChannel()), \
                         patch.object(app.discord, "TextChannel", FakeChannel), \
                         patch.object(app.discord, "Thread", FakeChannel), \
                         patch.object(app.live_token_budget, "turn_interval_seconds", return_value=10.0), \
                         patch.object(app.asyncio, "sleep", new=observed):
                        with self.assertRaises(Beat):
                            await bot._run_autonomous_continuation("group:9")
                    observed.assert_awaited()
                    generated.assert_not_awaited()
                    self.assertEqual(test_store.autonomous_continuation_count(), 1)

                    bot.last_ai_turn_at.clear()
                    with patch.object(app, "store", test_store), \
                         patch.object(app, "process_character_reply", new=generated), \
                         patch.object(bot, "get_channel", return_value=FakeChannel()), \
                         patch.object(app.discord, "TextChannel", FakeChannel), \
                         patch.object(app.discord, "Thread", FakeChannel), \
                         patch.object(app.live_token_budget, "turn_interval_seconds", return_value=0.0), \
                         patch.object(app.live_token_budget, "remaining_turns", return_value=6), \
                         patch.object(bot, "_send_character_output", new=send), \
                         patch.object(bot, "_resolve_next_speaker", new=AsyncMock(return_value=None)), \
                         patch.object(app.asyncio, "sleep", new=AsyncMock()):
                        await bot._run_autonomous_continuation("group:9")
                    generated.assert_awaited_once()
                    send.assert_awaited_once()
                    self.assertEqual(test_store.autonomous_continuation_count(), 0)
                finally:
                    await bot.close()
                    test_store.close()

        asyncio.run(run_test())

    def test_a_self_started_line_is_answered_once_by_another_character(self):
        async def run_test():
            import time
            import aira.discord_app as app
            from aira.characters import Character
            from aira.store import Store

            class FakeChannel:
                pass

            isla = Character("isla", "Isla", ("Isla",), Path("isla.md"))
            rem = Character("rem", "Rem", ("Rem",), Path("rem.md"))
            with tempfile.TemporaryDirectory() as directory:
                test_store = Store(Path(directory) / "idle-open.db")
                bot = AiraBot()
                test_store.save_message("user", "ไว้คุยกันใหม่", "2026-01-01T00:00:00Z",
                                        "group:9", "1", "Alice")
                reply = {"character": isla, "text": "ไอล่าว่าใครว่างบ้างคะ", "mood": "", "color": None,
                         "image": "", "rps": None, "next_speaker_id": "", "message_row_id": 1}
                try:
                    with patch.object(app, "store", test_store), \
                         patch.object(app, "process_character_reply", new=AsyncMock(return_value=reply)), \
                         patch.object(app, "idle_candidate_order", return_value=[isla, rem]), \
                         patch.object(bot, "get_channel", return_value=FakeChannel()), \
                         patch.object(app.discord, "TextChannel", FakeChannel), \
                         patch.object(app.discord, "Thread", FakeChannel), \
                         patch.object(bot, "_send_character_output",
                                      new=AsyncMock(return_value=SimpleNamespace(id="111"))), \
                         patch.object(bot, "_resolve_next_speaker", new=AsyncMock(return_value=None)):
                        started = await bot._start_idle_turn("9", "group:9", 40.0)
                    self.assertTrue(started)
                    state = test_store.get_autonomous_continuation("group:9")
                    self.assertIsNotNone(state)
                    self.assertEqual(state["previous"]["next_speaker_id"], "rem")
                finally:
                    await bot.close()
                    test_store.close()

        asyncio.run(run_test())

    def test_a_user_message_cancels_the_character_exchange(self):
        async def run_test():
            import time
            import aira.discord_app as app
            from aira.store import Store

            with tempfile.TemporaryDirectory() as directory:
                test_store = Store(Path(directory) / "chat-cancel.db")
                bot = AiraBot()
                test_store.save_autonomous_continuation("group:9", "9", {
                    "created_at": time.time(), "batch_id": "batch-1", "hops": 2,
                    "incoming": {"user_id": "1", "user": "Alice", "text": "คุยกัน",
                                 "timestamp": "2026-01-01T00:00:00Z", "session_key": "group:9",
                                 "speakers": [{"user_id": "1", "user": "Alice"}]},
                    "last": {"user_id": "1", "user": "Alice", "channel_id": "9",
                             "message_id": "10", "session_key": "group:9"},
                    "previous": {"character_id": "isla", "character_name": "Isla",
                                 "text": "Isla ตอบ", "next_speaker_id": "rem"},
                    "pending_send": None,
                })
                running = asyncio.create_task(asyncio.sleep(30))
                bot.autonomous_tasks["group:9"] = running
                try:
                    with patch.object(app, "store", test_store):
                        bot._cancel_autonomous_continuation("group:9")
                    await asyncio.sleep(0)
                    self.assertTrue(running.cancelled())
                    self.assertEqual(test_store.autonomous_continuation_count(), 0)
                    self.assertNotIn("group:9", bot.autonomous_tasks)
                finally:
                    await bot.close()
                    test_store.close()

        asyncio.run(run_test())


    def test_later_speakers_answer_the_previous_character_not_the_user_again(self):
        async def run_test():
            from aira.characters import Character
            chars = [
                Character("isla", "Isla", ("Isla",), Path("isla.md")),
                Character("rem", "Rem", ("Rem",), Path("rem.md")),
            ]
            seen = []

            async def fake_reply(message, character, prepared_media=None, input_saved=False, superseded=None):
                seen.append({"character": character.id, "text": message["text"],
                             "character_turn": bool(message.get("character_turn")),
                             "trigger": message.get("trigger_character_id")})
                return {"character": character, "text": f"{character.id} พูดว่า...", "mood": "",
                        "color": None, "image": "", "rps": None, "character_turn": True,
                        "next_speaker_id": ""}

            bot = AiraBot()
            channel = MagicMock(spec=discord.TextChannel)
            channel.send = AsyncMock()
            try:
                with patch("aira.discord_app.select_characters", new=AsyncMock(return_value=chars)), \
                     patch("aira.discord_app.process_character_reply", new=fake_reply), \
                     patch("aira.discord_app.store.save_message"), \
                     patch("aira.discord_app.store.get_response_channel_id", return_value="9", create=True), \
                     patch.object(bot, "_send_character_output", new=AsyncMock()), \
                     patch("aira.discord_app.prepare_attachments", new=AsyncMock(
                         return_value=SimpleNamespace(parts=[], summary="", file_names=[]))), \
                     patch("aira.discord_app.get_response_channel_id", return_value="9"), \
                     patch.object(bot, "get_channel", return_value=channel):
                    await bot._process_batch([{
                        "user_id": "1", "user": "Yuuta", "text": "ทุกคนคิดยังไงบ้าง",
                        "timestamp": "2026-11-25T17:00:00+00:00", "channel_id": "9",
                        "message_id": "555", "session_key": "group:9", "attachments": [],
                        "embeds": [], "raw_content": "ทุกคนคิดยังไงบ้าง", "file_name": None,
                    }])
            finally:
                await bot.close()
            self.assertEqual([item["character"] for item in seen], ["isla", "rem"])
            self.assertIn("ทุกคนคิดยังไงบ้าง", seen[0]["text"])
            self.assertFalse(seen[0]["character_turn"])
            # The second speaker answers Isla's line, not the user's message again.
            self.assertEqual(seen[1]["text"], "isla พูดว่า...")
            self.assertTrue(seen[1]["character_turn"])
            self.assertEqual(seen[1]["trigger"], "isla")

        asyncio.run(run_test())

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
                         patch.object(app.live_token_budget, "remaining_turns", return_value=5), \
                         patch.object(app, "decide_next_speaker",
                                      new=AsyncMock(return_value=None)) as decision, \
                         patch.object(bot, "_send_character_output", new=AsyncMock()) as send:
                        await bot._run_autonomous_continuation("group:9")
                    generated.assert_awaited_once()
                    self.assertEqual(generated.await_args.args[1].id, "rem")
                    self.assertEqual(generated.await_args.args[0]["text"], "Isla ตอบก่อนหน้า")
                    send.assert_awaited_once()
                    sent = send.await_args.args[1]
                    self.assertEqual(sent["text"], "Rem ตอบต่อ")
                    decision.assert_awaited_once()
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
