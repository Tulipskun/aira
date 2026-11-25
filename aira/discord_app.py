from __future__ import annotations

import asyncio
import json
import logging
import mimetypes
import time
import uuid
from types import SimpleNamespace

import discord
from discord import app_commands
from discord.ext import commands

from .characters import load_characters, save_character
from .config import ROOT, config, load_settings, save_settings
from .media import prepare_attachments
from .liveness import Liveness
from .pipeline import process_character_reply, process_message, select_characters, shutdown_pipeline
from .relationships import bond_emoji, bond_label
from .scheduler import MessageScheduler
from .store import store, utc_now
from .thought_signatures import close_thought_signatures

log = logging.getLogger("aira.discord")
DISCORD_CONFIG = ROOT / ".aira" / "discord-config.json"
RPS_CHOICES = {"rock": ("ค้อน", "✊🏻"), "paper": ("กระดาษ", "🖐🏻"), "scissors": ("กรรไกร", "✌🏻")}
RPS_GAMES: dict[str, dict] = {}
CHARACTER_WEBHOOKS: dict[tuple[int, str], discord.Webhook] = {}


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


def build_footer(status: dict | None, mood: str | None, private: bool) -> str:
    status = status or {}
    name = _clip(str(status.get("user_name") or "Isla"), 12)
    bond = status.get("bond")
    parts = [name]
    if bond in {"stranger", "acquaintance", "friend", "close_friend", "crush", "lover", "soulmate", "enemy", "sibling", "family"}:
        parts.extend([f"({bond_label(bond)})", f"({bond_emoji(bond)})" if private else bond_emoji(bond)])
    if isinstance(status.get("xp"), int):
        parts.append(str(status["xp"]))
    delta = status.get("xp_delta")
    if isinstance(delta, int) and delta:
        parts.append(f"[{delta:+d}]")
    if status.get("flirt_delta"):
        parts.append(f"[Flirt +{status['flirt_delta']}]")
    if status.get("bond_unlocked"):
        parts.append(f"[{bond_label(bond)} Unlocked]")
    for nickname in (status.get("nickname") or [])[:3]:
        cleaned = _clip(str(nickname).replace("#", "").strip(), 24)
        if cleaned:
            parts.append("#" + cleaned)
    footer = " ".join(filter(None, parts))
    if mood:
        footer += "\nอารมณ์: " + _clip(str(mood), 60)
    return footer or "Isla"


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
    embedding = discord.ui.TextInput(label="Embedding model", max_length=100)

    def __init__(self):
        super().__init__()
        settings = load_settings()
        self.gemini1.default = config.gemini1_model
        self.gemini2.default = config.gemini2_model
        self.embedding.default = settings.get("embeddingModel", config.embedding_model)

    async def on_submit(self, interaction: discord.Interaction):
        settings = load_settings()
        settings.update({"gemini1Model": str(self.gemini1.value).strip(),
                         "gemini2Model": str(self.gemini2.value).strip(),
                         "embeddingModel": str(self.embedding.value).strip()})
        save_settings(settings)
        config.gemini1_model = settings["gemini1Model"]
        config.gemini2_model = settings["gemini2Model"]
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
        self.scheduler = MessageScheduler(self._flush, debounce_ms=5000, max_wait_ms=12000)
        self.tree.add_command(app_commands.Command(name="aira", description="เปิดแผงควบคุมผู้ดูแล Aira", callback=self.open_admin_panel))
        self.in_flight = 0
        self.typing_tasks: dict[str, asyncio.Task] = {}
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

    async def start_health_server(self):
        from aiohttp import web

        async def health(_request):
            state = self.liveness.state()
            state.update({"pending": self.scheduler.pending_count(), "inFlight": self.in_flight})
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
        scheduled = {
            "user_id": str(message.author.id), "user": message.author.display_name,
            "text": text, "raw_content": message.content, "timestamp": message.created_at.isoformat(),
            "file_name": attachments[0].filename if attachments else None,
            "attachments": attachments, "embeds": list(message.embeds),
            "channel_id": str(message.channel.id), "message_id": str(message.id),
            "session_key": session_key,
        }
        self.scheduler.interrupt_other_sessions(session_key)
        self.scheduler.push(scheduled)
        self.liveness.note("queued")
        self._start_typing(str(message.channel.id))

    def _start_typing(self, channel_id: str):
        task = self.typing_tasks.get(channel_id)
        if task and not task.done():
            return
        async def loop():
            while self.scheduler.has_pending() or self.in_flight:
                channel = self.get_channel(int(channel_id))
                if channel and hasattr(channel, "typing"):
                    try:
                        async with channel.typing():
                            await asyncio.sleep(7)
                    except (discord.HTTPException, asyncio.CancelledError):
                        if asyncio.current_task() and asyncio.current_task().cancelled():
                            return
                await asyncio.sleep(0.5)
        self.typing_tasks[channel_id] = asyncio.create_task(loop())

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
        CHARACTER_WEBHOOKS[cache_key] = webhook
        return webhook

    async def _flush(self, messages: list[dict]):
        if not messages or messages[0]["channel_id"] != get_response_channel_id():
            return
        channel = self.get_channel(int(messages[-1]["channel_id"]))
        if not isinstance(channel, (discord.TextChannel, discord.Thread)):
            return
        self.in_flight += 1
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
            }
            store.save_message(
                "user", text or "(ไม่มีข้อความแนบมา)", incoming["timestamp"],
                incoming["session_key"], incoming["user_id"], incoming["user"],
                incoming["file_name"], None,
            )
            selected = await select_characters(incoming)
            if not selected:
                log.debug("No character chose to speak in channel %s", last["channel_id"])
                return

            outputs = []
            failed = []
            for character in selected:
                try:
                    if character.id == "isla":
                        response = await process_message(incoming, prepared, input_saved=True)
                        if response["text"]:
                            outputs.append({"character": character, **response})
                    else:
                        response = await process_character_reply(
                            incoming, character, prepared, input_saved=True,
                        )
                        if response["text"]:
                            outputs.append(response)
                except Exception:
                    failed.append(character.name)
                    log.exception("Character %s failed for %s", character.id, last["user_id"])

            sent = None
            for output in outputs:
                character = output["character"]
                if character.id == "isla":
                    result = output
                    embed = discord.Embed(description=result["text"])
                    embed.color = (discord.Color(result["color"])
                                   if result.get("color") is not None else discord.Color.default())
                    embed.timestamp = discord.utils.utcnow()
                    embed.set_footer(text=build_footer(
                        result.get("status"), result.get("mood"),
                        messages[0]["session_key"].startswith("user:"),
                    ))
                    files = []
                    if result.get("image"):
                        path = config.images_dir / result["image"]
                        if path.is_file():
                            files.append(discord.File(path, filename=path.name))
                            embed.set_image(url=f"attachment://{path.name}")
                    view = None
                    if result.get("rps") in RPS_CHOICES:
                        game_id = str(uuid.uuid4())
                        RPS_GAMES[game_id] = {
                            "user_id": int(last["user_id"]), "user_name": last["user"],
                            "isla_choice": result["rps"], "session_key": incoming["session_key"],
                            "channel_id": last["channel_id"], "message_id": last["message_id"],
                        }
                        view = RpsView(self, game_id)
                else:
                    embed = discord.Embed(description=output["text"])
                    embed.timestamp = discord.utils.utcnow()
                webhook = await self._character_webhook(channel, character)
                send_kwargs = {
                    "username": character.name,
                    "wait": True,
                }
                if character.avatar_url:
                    send_kwargs["avatar_url"] = character.avatar_url
                if isinstance(channel, discord.Thread):
                    send_kwargs["thread"] = channel
                if character.id == "isla":
                    send_kwargs.update(embed=embed, files=files, view=view)
                else:
                    send_kwargs["embed"] = embed
                sent = await webhook.send(**send_kwargs)
                if sent is None:
                    raise RuntimeError(f"Discord did not return the sent message for {character.id}")

            if failed and not outputs and len(failed) == len(selected):
                raise RuntimeError("All selected characters failed: " + ", ".join(failed))
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
        await shutdown_pipeline()
        await self.liveness.close()
        if self.health_server:
            await self.health_server.cleanup()
        for task in self.typing_tasks.values():
            task.cancel()
        RPS_GAMES.clear()
        await close_thought_signatures()
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
