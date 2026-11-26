from __future__ import annotations

import asyncio
from collections import deque
import json
import logging
import mimetypes
import time
import uuid
from pathlib import Path
from types import SimpleNamespace

import aiohttp
import discord
from discord import app_commands
from discord.ext import commands

from .characters import load_characters, save_character
from .config import ROOT, config, load_settings, save_settings
from .media import prepare_attachments
from .liveness import Liveness
from .pipeline import (
    CHAIN_MAX_HOPS, _save_incoming_message, decide_next_speaker, process_character_reply,
    select_characters, shutdown_pipeline,
)
from .scheduler import MessageScheduler
from .store import store, utc_now
from .token_budget import live_token_budget

log = logging.getLogger("aira.discord")
DISCORD_CONFIG = ROOT / ".aira" / "discord-config.json"
RPS_CHOICES = {"rock": ("ค้อน", "✊🏻"), "paper": ("กระดาษ", "🖐🏻"), "scissors": ("กรรไกร", "✌🏻")}
RPS_GAMES: dict[str, dict] = {}
CHARACTER_WEBHOOKS: dict[tuple[int, str], discord.Webhook] = {}
CHARACTER_WEBHOOK_AVATARS: set[tuple[int, str]] = set()


def _load_discord_config() -> dict:
    try:
        value = json.loads(DISCORD_CONFIG.read_text("utf-8"))
        return {"responseChannelId": value.get("responseChannelId") if isinstance(value.get("responseChannelId"), str) else None}
    except (OSError, ValueError):
        return {"responseChannelId": config.response_channel_id or None}


def _save_discord_config(value: dict) -> None:
    DISCORD_CONFIG.parent.mkdir(parents=True, exist_ok=True)
    temp = DISCORD_CONFIG.with_suffix(".tmp")
    temp.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")
    temp.replace(DISCORD_CONFIG)


def get_response_channel_id() -> str | None:
    return _load_discord_config().get("responseChannelId")


def set_response_channel_id(channel_id: str | None) -> None:
    _save_discord_config({"responseChannelId": channel_id})


def _clip(text: str, limit: int) -> str:
    text = " ".join((text or "").split())
    return text if len(text) <= limit else text[:max(0, limit - 1)] + "…"


def build_footer(mood: str | None) -> str:
    mood = _clip(str(mood or ""), 60)
    return "อารมณ์: " + mood if mood else ""


def _rps_outcome(isla: str, user: str, user_name: str) -> str:
    if isla == user:
        result = "เสมอ"
    elif (isla, user) in {("rock", "scissors"), ("scissors", "paper"), ("paper", "rock")}:
        result = "Isla ชนะ"
    else:
        result = f"{user_name} ชนะ"
    return f"Isla: {isla} {user_name}: {user} ผลลัพธ์: {result}"


class RpsView(discord.ui.View):
    def __init__(self, bot: "AiraBot", game_id: str):
        super().__init__(timeout=30)
        self.bot_ref = bot
        self.game_id = game_id
        for choice, (label, emoji) in RPS_CHOICES.items():
            button = discord.ui.Button(label=label, emoji=emoji, style=discord.ButtonStyle.primary)
            button.callback = self._callback(choice)
            self.add_item(button)

    def _callback(self, choice: str):
        async def callback(interaction: discord.Interaction):
            game = RPS_GAMES.pop(self.game_id, None)
            if not game:
                await interaction.response.send_message("เกมนี้หมดอายุแล้ว", ephemeral=True)
                return
            if interaction.user.id != game["user_id"]:
                RPS_GAMES[self.game_id] = game
                await interaction.response.send_message("คุณไม่ใช่เจ้าของเกมนี้", ephemeral=True)
                return
            for item in self.children:
                item.disabled = True
            await interaction.response.edit_message(view=self)
            self.bot_ref.scheduler.push({
                "user_id": str(game["user_id"]), "user": game["user_name"],
                "text": "[RPS] " + _rps_outcome(game["isla_choice"], choice, game["user_name"]),
                "timestamp": utc_now(), "session_key": game["session_key"],
                "channel_id": game["channel_id"], "message_id": game["message_id"], "immediate": True,
            })
        return callback

    async def on_timeout(self):
        RPS_GAMES.pop(self.game_id, None)
        for child in self.children:
            child.disabled = True
        if self.message:
            try:
                await self.message.edit(view=self)
            except discord.HTTPException:
                log.debug("RPS timeout view cleanup failed", exc_info=True)


class ApiKeyModal(discord.ui.Modal, title="Gemini API Key"):
    keys = discord.ui.TextInput(label="API key(s), คั่นด้วย comma", style=discord.TextStyle.paragraph,
                                required=True, max_length=4000, placeholder="AIza...")

    async def on_submit(self, interaction: discord.Interaction):
        values = [part.strip() for part in str(self.keys.value).split(",") if part.strip()]
        if not values:
            await interaction.response.send_message("กรุณาใส่ API Key อย่างน้อยหนึ่งค่า", ephemeral=True)
            return
        settings = load_settings()
        settings["geminiApiKeys"] = ",".join(values)
        save_settings(settings)
        config.gemini_keys = values
        config.gemini1_keys = values
        config.gemini2_keys = values
        config.embedding_keys = values
        await interaction.response.send_message("บันทึก Gemini API Key แล้ว", ephemeral=True)


class ModelModal(discord.ui.Modal, title="Gemini Model Settings"):
    gemini1 = discord.ui.TextInput(label="Gemini 1 Live model", max_length=100)
    gemini2 = discord.ui.TextInput(label="Gemini 2 Live model", max_length=100)
    decision = discord.ui.TextInput(label="Speaker decision model", max_length=100)
    embedding = discord.ui.TextInput(label="Embedding model", max_length=100)

    def __init__(self):
        super().__init__()
        settings = load_settings()
        self.gemini1.default = config.gemini1_model
        self.gemini2.default = config.gemini2_model
        self.decision.default = config.decision_model
        self.embedding.default = settings.get("embeddingModel", config.embedding_model)

    async def on_submit(self, interaction: discord.Interaction):
        settings = load_settings()
        settings.update({"gemini1Model": str(self.gemini1.value).strip(),
                         "gemini2Model": str(self.gemini2.value).strip(),
                         "decisionModel": str(self.decision.value).strip(),
                         "embeddingModel": str(self.embedding.value).strip()})
        save_settings(settings)
        config.gemini1_model = settings["gemini1Model"]
        config.gemini2_model = settings["gemini2Model"]
        config.decision_model = settings["decisionModel"]
        config.embedding_model = settings["embeddingModel"]
        await interaction.response.send_message("บันทึก Model แล้ว มีผลกับคำขอถัดไป", ephemeral=True)


class CharacterModal(discord.ui.Modal, title="Character Editor"):
    character_id = discord.ui.TextInput(label="Character ID (a-z, 0-9, _ or -)", max_length=32)
    name = discord.ui.TextInput(label="ชื่อที่แสดง", max_length=80)
    aliases = discord.ui.TextInput(label="ชื่อเรียกอื่น คั่นด้วย comma", required=False, max_length=500)
    prompt = discord.ui.TextInput(label="บุคลิก / System Prompt (เว้นว่างเพื่อคงค่าเดิม)",
                                  style=discord.TextStyle.paragraph, required=False, max_length=4000)
    enabled = discord.ui.TextInput(label="เปิดใช้งาน? true หรือ false", required=False, max_length=5, default="true")

    async def on_submit(self, interaction: discord.Interaction):
        try:
            active = str(self.enabled.value or "true").strip().lower()
            if active not in {"true", "false"}:
                raise ValueError("ค่าเปิดใช้งานต้องเป็น true หรือ false")
            character_id = str(self.character_id.value).strip().lower()
            prompt_text = str(self.prompt.value).strip()
            if not prompt_text:
                definition_path = ROOT / "characters" / f"{character_id}.json"
                definition = json.loads(definition_path.read_text("utf-8"))
                prompt_path = (ROOT / "characters" / str(definition["promptFile"])).resolve()
                prompt_text = prompt_path.read_text("utf-8")
            save_character(character_id, str(self.name.value).strip(),
                           [x.strip() for x in str(self.aliases.value).split(",") if x.strip()],
                           prompt_text, active == "true")
        except (ValueError, OSError) as exc:
            await interaction.response.send_message(str(exc), ephemeral=True)
            return
        await interaction.response.send_message("บันทึกตัวละครแล้ว มีผลกับข้อความถัดไป", ephemeral=True)


class PanelView(discord.ui.View):
    def __init__(self, bot: "AiraBot"):
        super().__init__(timeout=None)
        self.bot_ref = bot

    @discord.ui.button(label="ตั้งค่า Gemini API", style=discord.ButtonStyle.primary, custom_id="aira:api")
    async def api_button(self, interaction: discord.Interaction, button: discord.ui.Button):
        if not self.bot_ref.is_owner(interaction.user.id):
            await interaction.response.send_message("แผงควบคุมนี้ใช้ได้เฉพาะเจ้าของบอท", ephemeral=True)
            return
        await interaction.response.send_modal(ApiKeyModal())

    @discord.ui.button(label="ตั้งค่า Model", style=discord.ButtonStyle.secondary, custom_id="aira:models")
    async def models_button(self, interaction: discord.Interaction, button: discord.ui.Button):
        if not self.bot_ref.is_owner(interaction.user.id):
            await interaction.response.send_message("แผงควบคุมนี้ใช้ได้เฉพาะเจ้าของบอท", ephemeral=True)
            return
        await interaction.response.send_modal(ModelModal())

    @discord.ui.button(label="เพิ่ม / แก้ตัวละคร", style=discord.ButtonStyle.secondary, custom_id="aira:character")
    async def character_button(self, interaction: discord.Interaction, button: discord.ui.Button):
        if not self.bot_ref.is_owner(interaction.user.id):
            await interaction.response.send_message("แผงควบคุมนี้ใช้ได้เฉพาะเจ้าของบอท", ephemeral=True)
            return
        await interaction.response.send_modal(CharacterModal())

    @discord.ui.button(label="รีเฟรช", style=discord.ButtonStyle.success, custom_id="aira:refresh")
    async def refresh_button(self, interaction: discord.Interaction, button: discord.ui.Button):
        if not self.bot_ref.is_owner(interaction.user.id):
            await interaction.response.send_message("แผงควบคุมนี้ใช้ได้เฉพาะเจ้าของบอท", ephemeral=True)
            return
        await interaction.response.edit_message(embed=self.bot_ref.panel_embed(), view=self)

    @discord.ui.select(cls=discord.ui.ChannelSelect, channel_types=[discord.ChannelType.text],
                       placeholder="เลือกห้องที่ให้ Aira ตอบ", min_values=1, max_values=1,
                       custom_id="aira:channel")
    async def channel_select(self, interaction: discord.Interaction, select: discord.ui.ChannelSelect):
        if not self.bot_ref.is_owner(interaction.user.id):
            await interaction.response.send_message("แผงควบคุมนี้ใช้ได้เฉพาะเจ้าของบอท", ephemeral=True)
            return

        # A component interaction has a strict 3-second acknowledgement deadline.
        # Defer before permission checks and disk I/O, then edit the original panel.
        await interaction.response.defer()
        try:
            selected = select.values[0]
            guild = interaction.guild
            bot_member = guild.me if guild else None
            # ChannelSelect returns AppCommandChannel, not a full GuildChannel.
            # Resolve it from cache or fetch it before checking the bot's own perms.
            channel = selected.resolve()
            if channel is None:
                channel = await selected.fetch()
            permissions = channel.permissions_for(bot_member) if bot_member else None
            if not permissions or not permissions.view_channel or not permissions.send_messages:
                await interaction.followup.send("บอทไม่มีสิทธิ์ดูหรือส่งข้อความในห้องนี้", ephemeral=True)
                return
            set_response_channel_id(str(selected.id))
            await interaction.edit_original_response(embed=self.bot_ref.panel_embed(), view=self)
        except (discord.HTTPException, OSError, ValueError):
            log.exception("Failed to save selected response channel")
            await interaction.followup.send("บันทึกห้องไม่สำเร็จ กรุณาลองใหม่อีกครั้ง", ephemeral=True)


class AiraBot(commands.Bot):
    def __init__(self):
        intents = discord.Intents.none()
        intents.guilds = True
        intents.guild_messages = True
        intents.message_content = True
        super().__init__(command_prefix="!", intents=intents, help_command=None)
        self.owner_id = int(config.owner_id) if config.owner_id.isdigit() else None
        self.scheduler = MessageScheduler(self._flush, debounce_ms=320, max_wait_ms=1500)
        self.tree.add_command(app_commands.Command(name="aira", description="เปิดแผงควบคุมผู้ดูแล Aira", callback=self.open_admin_panel))
        self.in_flight = 0
        self.autonomous_history: dict[str, deque[float]] = {}
        self.autonomous_tasks: dict[str, asyncio.Task] = {}
        self.started_at = time.time()
        self.health_server = None
        self._closed = False
        # AiraBot uses commands.Bot (single gateway connection), not AutoShardedBot.
        self.liveness = Liveness(
            lambda: {0: self.is_ready()},
            get_response_channel_id,
        )

    def is_owner(self, user_id: int) -> bool:
        return self.owner_id is not None and user_id == self.owner_id

    async def open_admin_panel(self, interaction: discord.Interaction):
        if not self.is_owner(interaction.user.id):
            await interaction.response.send_message("คำสั่งนี้ใช้ได้เฉพาะเจ้าของบอท", ephemeral=True)
            return
        await interaction.response.send_message(embed=self.panel_embed(), view=PanelView(self), ephemeral=True)

    def panel_embed(self) -> discord.Embed:
        channel_id = get_response_channel_id()
        descriptions = [
            "ตั้งค่าบอทจากแผงควบคุมนี้ได้โดยตรง",
            "",
            f"**ช่องตอบกลับ:** {f'<#{channel_id}>' if channel_id else 'ยังไม่ได้เลือก'}",
            f"**Gemini API:** {'ตั้งค่าแล้ว' if config.gemini_keys else 'ยังไม่ได้ตั้งค่า'}",
            f"**Gemini 1:** {config.gemini1_model}",
            f"**Gemini 2:** {config.gemini2_model}",
            f"**Decision:** {config.decision_model}",
            "",
            "**ตัวละคร:** " + ", ".join(x.name for x in load_characters()),
            "",
            "เลือกช่องตอบกลับ ตั้งค่า Gemini API/Model หรือจัดการตัวละครจากปุ่มด้านล่าง",
        ]
        embed = discord.Embed(title="Aira • Control Panel", description="\n".join(descriptions), color=0x7C6EE6)
        embed.set_footer(text="การตั้งค่าสำคัญอนุญาตเฉพาะเจ้าของแอป Discord")
        return embed

    async def setup_hook(self):
        from .memory import (
            migrate_character_memory_sessions, migrate_legacy_chroma, migrate_memory_sessions,
            reset_persistent_memory_once,
        )
        reset = reset_persistent_memory_once()
        if reset.get("reset"):
            log.warning("Performed approved one-time fresh-memory reset: %s", reset)
        legacy = migrate_legacy_chroma()
        if legacy.get("migrated"):
            log.info("Imported legacy Chroma memories into SQLite: %s", legacy)
        migration = await migrate_memory_sessions()
        if migration["backfilled"]:
            log.info("SQLite memory sessions backfilled: %s", migration)
        character_memory = migrate_character_memory_sessions()
        if any(character_memory.values()):
            log.info("Legacy room memories assigned to Isla: %s", character_memory)
        self.add_view(PanelView(self))
        log.info("Registered owner-only /aira admin panel command")

    async def on_ready(self):
        log.info("Logged in as %s", self.user)
        log.info("Response channel: %s", get_response_channel_id() or "not set")
        if self.health_server is None:
            self.health_server = await self.start_health_server()
        self.liveness.start()
        for session_key, _channel_id, _payload in store.list_autonomous_continuations():
            self._schedule_autonomous_continuation(session_key)

    async def start_health_server(self):
        from aiohttp import web

        async def health(_request):
            state = self.liveness.state()
            state.update({
                "pending": self.scheduler.pending_count(),
                "inFlight": self.in_flight,
                "autonomousContinuations": store.autonomous_continuation_count(),
                "historyCache": store.history_cache_stats(),
                "geminiTPM": live_token_budget.snapshot(),
            })
            return web.json_response(state)
        app = web.Application()
        app.router.add_get("/health", health)
        runner = web.AppRunner(app)
        await runner.setup()
        site = web.TCPSite(runner, "127.0.0.1", config.health_port)
        try:
            await site.start()
            log.info("Health endpoint listening on http://127.0.0.1:%s/health", config.health_port)
        except OSError as exc:
            log.warning("Health endpoint unavailable: %s", exc)
            await runner.cleanup()
            return None
        return runner

    async def on_message(self, message: discord.Message):
        self.liveness.note("seen")
        if message.author.bot:
            self.liveness.note("dropped")
            return
        self.liveness.note("nonBot")
        text = message.clean_content.strip()
        if text.startswith("!"):
            self.liveness.note("command")
            return
        response_channel = get_response_channel_id()
        if not response_channel or str(message.channel.id) != response_channel:
            self.liveness.note("offChannel")
            return
        attachments = list(message.attachments)
        for sticker in message.stickers:
            sticker_url = str(sticker.url)
            suffix = Path(sticker_url.split("?", 1)[0]).suffix or ".png"
            format_value = int(getattr(getattr(sticker, "format", None), "value", getattr(sticker, "format", 1)))
            content_type = {1: "image/png", 2: "image/png", 3: "application/lottie", 4: "image/gif"}.get(
                format_value, mimetypes.guess_type("sticker" + suffix)[0] or "image/png"
            )
            attachments.append(SimpleNamespace(filename=f"sticker-{sticker.id}{suffix}", url=sticker_url,
                                                content_type=content_type, size=0))
        if not text and not attachments:
            self.liveness.note("dropped")
            return
        session_key = store.session_key_for(str(message.author.id), str(message.channel.id))
        reply_reference = getattr(message, "reference", None)
        scheduled = {
            "user_id": str(message.author.id), "user": message.author.display_name,
            "text": text, "raw_content": message.content, "timestamp": message.created_at.isoformat(),
            "file_name": attachments[0].filename if attachments else None,
            "attachments": attachments, "embeds": list(message.embeds),
            "channel_id": str(message.channel.id), "message_id": str(message.id),
            "discord_message_id": str(message.id),
            "reply_to_message_id": (str(reply_reference.message_id)
                                    if getattr(reply_reference, "message_id", None) else None),
            "session_key": session_key,
        }
        self._cancel_autonomous_continuation(session_key)
        self.scheduler.interrupt_other_sessions(session_key)
        self.scheduler.push(scheduled)
        self.liveness.note("queued")
        log.info("Message received and queued: message=%s channel=%s user=%s chars=%s attachments=%s",
                 message.id, message.channel.id, message.author.id, len(text), len(attachments))

    async def _character_webhook(self, channel, character):
        parent = channel.parent if isinstance(channel, discord.Thread) else channel
        if not isinstance(parent, discord.TextChannel):
            raise RuntimeError("Character webhooks require a text channel")
        cache_key = (parent.id, character.id)
        cached = CHARACTER_WEBHOOKS.get(cache_key)
        if cached is not None:
            return cached
        me = parent.guild.me
        permissions = parent.permissions_for(me) if me else None
        if not permissions or not permissions.manage_webhooks:
            raise PermissionError("Aira needs Manage Webhooks permission in the response channel")
        hooks = await parent.webhooks()
        hook_name = f"Aira Character ({character.id})"
        webhook = next((item for item in hooks
                        if item.name == hook_name and item.user and self.user
                        and item.user.id == self.user.id), None)
        if webhook is None:
            webhook = await parent.create_webhook(name=hook_name, reason="Separate Aira character identities")
        if character.avatar_url and cache_key not in CHARACTER_WEBHOOK_AVATARS:
            try:
                timeout = aiohttp.ClientTimeout(total=12, connect=5)
                async with aiohttp.ClientSession(timeout=timeout) as session:
                    async with session.get(character.avatar_url, allow_redirects=True) as response:
                        response.raise_for_status()
                        content_type = response.headers.get("Content-Type", "").split(";", 1)[0].lower()
                        if not content_type.startswith("image/"):
                            raise ValueError(f"Character avatar URL returned non-image content: {content_type}")
                        declared = response.content_length
                        if declared is not None and declared > 8 * 1024 * 1024:
                            raise ValueError("Character avatar image exceeds 8 MiB")
                        avatar_bytes = await response.read()
                        if not avatar_bytes or len(avatar_bytes) > 8 * 1024 * 1024:
                            raise ValueError("Character avatar image is empty or exceeds 8 MiB")
                updated = await webhook.edit(avatar=avatar_bytes, reason=f"Set {character.id} character avatar")
                if updated is not None:
                    webhook = updated
                CHARACTER_WEBHOOK_AVATARS.add(cache_key)
                log.info("Character webhook avatar updated: channel=%s character=%s bytes=%s",
                         parent.id, character.id, len(avatar_bytes))
            except Exception:
                log.exception("Could not set webhook avatar from configured URL: channel=%s character=%s",
                              parent.id, character.id)
        CHARACTER_WEBHOOKS[cache_key] = webhook
        return webhook

    async def _flush(self, messages: list[dict]):
        if not messages or messages[0]["channel_id"] != get_response_channel_id():
            return
        channel = self.get_channel(int(messages[-1]["channel_id"]))
        if not isinstance(channel, (discord.TextChannel, discord.Thread)):
            return
        await self._process_batch(messages)

    async def _resolve_next_speaker(self, output: dict, session_key: str):
        """Follow the character's own choice first, then let the decision model decide."""
        character = output["character"]
        next_id = str(output.get("next_speaker_id") or "").strip()
        if next_id and next_id != character.id:
            chosen = next((item for item in load_characters() if item.id == next_id), None)
            if chosen is not None:
                log.info("Continuation requested by the character: from=%s to=%s",
                         character.id, chosen.id)
                return chosen
        return await decide_next_speaker(character, str(output.get("text") or ""), session_key)

    def _autonomous_wait_seconds(self, channel_id: str) -> float:
        now = time.monotonic()
        history = self.autonomous_history.setdefault(channel_id, deque())
        while history and history[0] <= now - 300:
            history.popleft()
        if len(history) < 4:
            return 0.0
        return max(0.05, history[0] + 300 - now)

    def _record_autonomous_turn(self, channel_id: str) -> None:
        self.autonomous_history.setdefault(channel_id, deque()).append(time.monotonic())

    def _cancel_autonomous_continuation(self, session_key: str) -> None:
        store.delete_autonomous_continuation(session_key)
        task = self.autonomous_tasks.pop(session_key, None)
        if task and not task.done():
            task.cancel()

    def _schedule_autonomous_continuation(self, session_key: str) -> None:
        current = self.autonomous_tasks.get(session_key)
        if current and not current.done():
            return
        self.autonomous_tasks[session_key] = asyncio.create_task(
            self._run_autonomous_continuation(session_key),
            name=f"aira-autonomous-{session_key}",
        )

    @staticmethod
    def _continuation_output(state: dict) -> dict:
        from .characters import load_characters
        character_id = str(state.get("character_id") or "")
        character = next((item for item in load_characters() if item.id == character_id), None)
        if character is None:
            raise RuntimeError(f"Unknown character in autonomous continuation: {character_id}")
        return {"character": character, "text": str(state.get("text") or ""),
                "mood": str(state.get("mood") or ""), "color": state.get("color"),
                "image": str(state.get("image") or ""), "rps": state.get("rps"),
                "character_turn": bool(state.get("character_turn", True)),
                "next_speaker_id": str(state.get("next_speaker_id") or ""),
                "message_row_id": state.get("message_row_id")}

    async def _run_autonomous_continuation(self, session_key: str) -> None:
        try:
            while True:
                state = store.get_autonomous_continuation(session_key)
                if not state:
                    return
                if self.scheduler.has_pending_session(session_key):
                    log.info("Autonomous exchange interrupted by a new user message: session=%s", session_key)
                    store.delete_autonomous_continuation(session_key)
                    return
                if time.time() - float(state.get("created_at", time.time())) > 86400:
                    log.info("Discarding stale autonomous continuation: session=%s", session_key)
                    store.delete_autonomous_continuation(session_key)
                    return
                channel_id = str(state.get("channel_id") or "")
                channel = self.get_channel(int(channel_id)) if channel_id.isdigit() else None
                if not isinstance(channel, (discord.TextChannel, discord.Thread)):
                    try:
                        channel = await self.fetch_channel(int(channel_id))
                    except (discord.HTTPException, ValueError, TypeError):
                        log.exception("Could not restore channel for autonomous continuation: %s; retrying", channel_id)
                        await asyncio.sleep(30.0)
                        continue
                last = state["last"]
                batch_id = str(state.get("batch_id") or "autonomous")

                # A generated response is persisted before sending. If Discord briefly fails,
                # retry the same response instead of asking the model to generate it again.
                pending_send = state.get("pending_send")
                if pending_send:
                    try:
                        sent = await self._send_character_output(
                            channel, self._continuation_output(pending_send), last, batch_id, False,
                        )
                    except Exception:
                        log.exception("Could not send a persisted autonomous character reply; retrying")
                        await asyncio.sleep(10.0)
                        continue
                    state["pending_send"] = None
                    state["previous"]["discord_message_id"] = str(sent.id)
                    store.save_autonomous_continuation(session_key, channel_id, state)
                    continue

                previous = state.get("previous") or {}
                previous_id = str(previous.get("character_id") or "")
                next_id = str(previous.get("next_speaker_id") or "").strip()
                hops = int(state.get("hops") or 0)
                if hops >= CHAIN_MAX_HOPS:
                    log.info("Autonomous exchange reached the hop limit: session=%s hops=%s",
                             session_key, hops)
                    store.delete_autonomous_continuation(session_key)
                    return
                characters = load_characters()
                next_character = next((item for item in characters
                                        if item.id == next_id and item.id != previous_id), None)
                if next_character is None:
                    log.info("Autonomous exchange ended naturally: session=%s previous=%s next=%s",
                             session_key, previous_id, next_id or "(none)")
                    store.delete_autonomous_continuation(session_key)
                    return

                wait_seconds = self._autonomous_wait_seconds(channel_id)
                if wait_seconds > 0:
                    log.info("Autonomous exchange paused by channel turn guard: session=%s wait=%.1fs",
                             session_key, wait_seconds)
                    await asyncio.sleep(min(wait_seconds, 10.0))
                    continue
                if live_token_budget.available_tokens() <= 4096:
                    log.info("Autonomous exchange paused for TPM capacity: session=%s", session_key)
                    await asyncio.sleep(5.0)
                    continue

                turn_message = {
                    **state["incoming"],
                    "text": str(previous.get("text") or ""),
                    "timestamp": utc_now(),
                    "trigger_character": str(previous.get("character_name") or previous_id),
                    "trigger_character_id": previous_id,
                    "discord_message_id": previous.get("discord_message_id"),
                    "character_turn": True,
                }
                self._record_autonomous_turn(channel_id)
                log.info("Autonomous character turn: channel=%s speaker=%s replying_to=%s",
                         channel_id, next_character.id, previous_id)
                try:
                    response = await process_character_reply(
                        turn_message, next_character, prepared_media=None, input_saved=True,
                        superseded=lambda: self.scheduler.has_pending_session(session_key),
                    )
                except Exception:
                    log.exception("Autonomous generation failed for %s; preserving continuation and retrying",
                                  next_character.id)
                    await asyncio.sleep(15.0)
                    continue
                if not response.get("text"):
                    log.info("Autonomous character chose silence: speaker=%s", next_character.id)
                    store.delete_autonomous_continuation(session_key)
                    return
                response["character_turn"] = True
                resolved = await self._resolve_next_speaker(response, session_key)
                saved_output = {
                    "character_id": next_character.id, "text": response["text"],
                    "message_row_id": response.get("message_row_id"),
                    "mood": response.get("mood", ""), "color": response.get("color"),
                    "image": response.get("image", ""), "rps": response.get("rps"),
                    "character_turn": True,
                    "next_speaker_id": resolved.id if resolved else "",
                }
                state["hops"] = hops + 1
                state["previous"] = {
                    **saved_output, "character_name": next_character.name,
                }
                state["pending_send"] = saved_output
                store.save_autonomous_continuation(session_key, channel_id, state)
                # The next loop iteration sends the persisted output, then follows its next_speaker_id.
        except asyncio.CancelledError:
            raise
        except Exception:
            log.exception("Autonomous continuation worker failed: session=%s; retrying", session_key)
            if not self._closed:
                await asyncio.sleep(15.0)
                self.autonomous_tasks.pop(session_key, None)
                self._schedule_autonomous_continuation(session_key)
        finally:
            current = self.autonomous_tasks.get(session_key)
            if current is asyncio.current_task():
                self.autonomous_tasks.pop(session_key, None)

    async def _send_character_output(self, channel, output: dict, last: dict, batch_id: str,
                                     private: bool = False):
        character = output["character"]
        files = []
        view = None
        embed = discord.Embed(description=output["text"])
        embed.color = (discord.Color(output["color"])
                       if output.get("color") is not None else discord.Color.default())
        embed.timestamp = discord.utils.utcnow()
        footer = build_footer(output.get("mood"))
        if footer:
            embed.set_footer(text=footer)
        if output.get("image"):
            image_directory = config.images_dir / character.id
            path = image_directory / Path(output["image"]).name
            if path.is_file():
                files.append(discord.File(path, filename=path.name))
                embed.set_image(url=f"attachment://{path.name}")
        if character.id == "isla" and not output.get("character_turn") and output.get("rps") in RPS_CHOICES:
            game_id = str(uuid.uuid4())
            RPS_GAMES[game_id] = {
                "user_id": int(last["user_id"]), "user_name": last["user"],
                "isla_choice": output["rps"], "session_key": last["session_key"],
                "channel_id": last["channel_id"], "message_id": last["message_id"],
            }
            view = RpsView(self, game_id)

        webhook = await self._character_webhook(channel, character)
        send_kwargs = {"username": character.name, "wait": True, "embed": embed}
        if isinstance(channel, discord.Thread):
            send_kwargs["thread"] = channel
        if files:
            send_kwargs["files"] = files
        if view is not None:
            send_kwargs["view"] = view
        sent = await webhook.send(**send_kwargs)
        if sent is None:
            raise RuntimeError(f"Discord did not return the sent message for {character.id}")
        if output.get("message_row_id"):
            store.set_discord_message_id(int(output["message_row_id"]), str(sent.id))
        log.info("Discord webhook send succeeded: message=%s channel=%s character=%s sent_message=%s "
                 "webhook_avatar=%s webhook=%s",
                 batch_id, last["channel_id"], character.id, sent.id,
                 bool(getattr(webhook, "avatar", None)), getattr(webhook, "id", None))
        return sent

    async def _process_batch(self, messages: list[dict]):
        if not messages or messages[0]["channel_id"] != get_response_channel_id():
            return
        channel = self.get_channel(int(messages[-1]["channel_id"]))
        if not isinstance(channel, (discord.TextChannel, discord.Thread)):
            return
        self.in_flight += 1
        batch_id = messages[-1].get("message_id", "unknown")
        log.info("Processing batch: last_message=%s channel=%s messages=%s",
                 batch_id, messages[-1].get("channel_id"), len(messages))
        try:
            speakers = []
            for message in messages:
                speaker = {"user_id": message["user_id"], "user": message["user"]}
                if speaker not in speakers:
                    speakers.append(speaker)
            text = "\n".join(f"{item['user']}: {item['text'] or '(ไม่มีข้อความแนบมา)'}" for item in messages)
            attachments = [attachment for item in messages for attachment in item.get("attachments", [])]
            raw_content = "\n".join(item.get("raw_content", item.get("text", "")) for item in messages)
            embeds = [embed for item in messages for embed in item.get("embeds", [])]
            prepared = await prepare_attachments(attachments, content=raw_content, embeds=embeds)
            last = messages[-1]
            incoming = {
                "user_id": last["user_id"], "user": last["user"], "text": text,
                "timestamp": messages[0]["timestamp"], "file_name": messages[0].get("file_name"),
                "session_key": messages[0]["session_key"], "speakers": speakers,
                "media_summary": prepared.summary,
                "discord_message_id": str(last["message_id"]),
                "reply_to_message_id": last.get("reply_to_message_id"),
            }
            # Keep one row per Discord message so the transcript shows who said what and
            # which message each one answers, instead of a single row owned by the last user.
            for index, item in enumerate(messages):
                _save_incoming_message({
                    **item,
                    "media_summary": prepared.summary if index == len(messages) - 1 else None,
                })
            # A retry must not answer twice: if another message is already queued for this
            # room, its batch owns the next turn and the stale attempt is dropped.
            def superseded() -> bool:
                return self.scheduler.has_pending_session(incoming["session_key"])

            selected = await select_characters(incoming, prepared, superseded=superseded)
            log.info("Character selection complete: message=%s selected=%s",
                     batch_id, [character.id for character in selected])
            if not selected:
                log.info("No character chose to speak: message=%s channel=%s", batch_id, last["channel_id"])
                return

            outputs = []
            failed = []
            previous_spoken = None
            for character in selected:
                try:
                    log.info("Generating character reply: message=%s character=%s", batch_id, character.id)
                    # The first speaker answers the user; everyone after that answers the card
                    # just posted, exactly like the autonomous turn worker does. Otherwise the
                    # whole cast re-answers the same message and paraphrases the same answer.
                    turn = incoming if previous_spoken is None else {
                        **incoming,
                        "text": previous_spoken["text"],
                        "timestamp": utc_now(),
                        "character_turn": True,
                        "trigger_character": previous_spoken["character"].name,
                        "trigger_character_id": previous_spoken["character"].id,
                        "discord_message_id": previous_spoken.get("discord_message_id"),
                    }
                    response = await process_character_reply(
                        turn, character, prepared, input_saved=True, superseded=superseded,
                    )
                    if not response["text"]:
                        log.info("Character chose silence: message=%s character=%s", batch_id, character.id)
                        continue
                    sent = await self._send_character_output(
                        channel, response, last, batch_id,
                        messages[0]["session_key"].startswith("user:"),
                    )
                    previous_spoken = {**response, "discord_message_id": str(sent.id)}
                    outputs.append(previous_spoken)
                    log.info("Character reply generated: message=%s character=%s chars=%s",
                             batch_id, character.id, len(response["text"]))
                except Exception:
                    failed.append(character.name)
                    log.exception("Character %s failed for %s", character.id, last["user_id"])

            # Hand the last card to the continuation worker: it answers with whichever
            # character the reply points at, so a two-way exchange can keep going.
            if previous_spoken is not None:
                next_character = await self._resolve_next_speaker(previous_spoken, incoming["session_key"])
                if next_character is not None:
                    payload = {
                        "created_at": time.time(), "batch_id": batch_id, "hops": 1,
                        "incoming": {
                            "user_id": incoming["user_id"], "user": incoming["user"],
                            "text": incoming["text"], "timestamp": incoming["timestamp"],
                            "session_key": incoming["session_key"],
                            "speakers": incoming.get("speakers", []),
                        },
                        "last": {
                            "user_id": last["user_id"], "user": last["user"],
                            "channel_id": str(last["channel_id"]),
                            "message_id": str(last["message_id"]),
                            "session_key": last["session_key"],
                        },
                        "previous": {
                            "character_id": previous_spoken["character"].id,
                            "character_name": previous_spoken["character"].name,
                            "text": previous_spoken["text"],
                            "next_speaker_id": next_character.id,
                            "discord_message_id": previous_spoken.get("discord_message_id"),
                        },
                        "pending_send": None,
                    }
                    store.save_autonomous_continuation(incoming["session_key"], str(last["channel_id"]), payload)
                    self._schedule_autonomous_continuation(incoming["session_key"])

            if failed and not outputs and len(failed) == len(selected):
                raise RuntimeError("All selected characters failed: " + ", ".join(failed))
            if not outputs:
                log.info("Batch finished without a reply: message=%s selected=%s failed=%s",
                         batch_id, len(selected), len(failed))
        except Exception as exc:
            log.exception("Message pipeline failed")
            try:
                if isinstance(exc, PermissionError):
                    await channel.send("Aira ต้องได้รับสิทธิ์ Manage Webhooks ในห้องนี้ก่อน จึงจะแสดงชื่อและรูปประจำตัวของแต่ละตัวละครได้")
                else:
                    await channel.send("ขออภัยค่ะ... ไอลาประมวลผลข้อความนี้ไม่สำเร็จ กรุณาลองใหม่อีกครั้งนะคะ")
            except discord.HTTPException:
                log.exception("Could not send failure notice")
        finally:
            self.in_flight = max(0, self.in_flight - 1)

    async def close(self):
        if self._closed:
            return
        self._closed = True
        await self.scheduler.close()
        tasks = list(self.autonomous_tasks.values())
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        self.autonomous_tasks.clear()
        await shutdown_pipeline()
        await self.liveness.close()
        if self.health_server:
            await self.health_server.cleanup()
        RPS_GAMES.clear()
        store.close()
        await super().close()


async def run_bot():
    import signal

    if not config.discord_token:
        raise RuntimeError("Discord token is missing; start main.py and enter it in the console")
    if not config.gemini_keys:
        log.warning("Gemini API key is not configured; add it through /aira")
    config.sqlite_path.parent.mkdir(parents=True, exist_ok=True)
    from .warmup import warm_network
    await warm_network()
    bot = AiraBot()
    loop = asyncio.get_running_loop()
    stop = asyncio.Event()
    for signum in (signal.SIGTERM, signal.SIGINT):
        try:
            loop.add_signal_handler(signum, stop.set)
        except (NotImplementedError, RuntimeError):
            pass
    async with bot:
        start_task = asyncio.create_task(bot.start(config.discord_token), name="aira-discord-gateway")
        stop_task = asyncio.create_task(stop.wait(), name="aira-shutdown-signal")
        try:
            done, _ = await asyncio.wait({start_task, stop_task}, return_when=asyncio.FIRST_COMPLETED)
            if stop_task in done and not start_task.done():
                log.info("Shutdown signal received; draining pending turns")
                await bot.close()
            await start_task
        finally:
            stop_task.cancel()
            await asyncio.gather(stop_task, return_exceptions=True)
