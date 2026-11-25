import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  EmbedBuilder,
  ModalBuilder,
  PermissionFlagsBits,
  TextInputBuilder,
  TextInputStyle,
  MessageFlags,
  type Client,
  type Interaction,
  type TextChannel,
} from "discord.js";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { setResponseChannelId, getResponseChannelId } from "./discord-config.js";
import { config } from "../config.js";
import { loadCharacters } from "../characters/registry.js";

const SETTINGS_FILE = resolve(".aira/settings.json");
let ownerId: string | null = null;

type Settings = {
  geminiApiKeys?: string;
  gemini1Model?: string;
  gemini2Model?: string;
  embeddingModel?: string;
};

async function readSettings(): Promise<Settings> {
  try { return JSON.parse(await readFile(SETTINGS_FILE, "utf8")) as Settings; }
  catch { return {}; }
}

async function saveSettings(settings: Settings): Promise<void> {
  await mkdir(dirname(SETTINGS_FILE), { recursive: true });
  await writeFile(SETTINGS_FILE, JSON.stringify(settings, null, 2) + "\n", { mode: 0o600 });
  await chmod(SETTINGS_FILE, 0o600);
}

function panelEmbed(): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(0x7c6ee6)
    .setTitle("Aira • Control Panel")
    .setDescription([
      "ตั้งค่าบอทจากแผงควบคุมนี้ได้โดยตรง",
      "",
      `**ช่องตอบกลับ:** ${getResponseChannelId() ? `<#${getResponseChannelId()}>` : "ยังไม่ได้เลือก"}`,
      `**Gemini API:** ${(process.env.GEMINI_API_KEY ?? "").trim() ? "ตั้งค่าแล้ว" : "ยังไม่ได้ตั้งค่า"}`,
      `**Gemini 1:** ${config.models.gemini1}`,
      `**Gemini 2:** ${config.models.gemini2}`,
      "",
      "**ตัวละคร:** " + loadCharacters().map(character => character.name).join(", "),
      "",
      "เลือกช่องตอบกลับ เพิ่ม Gemini API Key หรือจัดการตัวละครจากปุ่มด้านล่าง",
    ].join("\n"))
    .setFooter({ text: "การตั้งค่าสำคัญอนุญาตเฉพาะเจ้าของแอป Discord" });
}

function panelRows() {
  const channel = new ChannelSelectMenuBuilder()
    .setCustomId("aira:channel")
    .setPlaceholder("เลือกห้องที่ให้ Aira ตอบ")
    .setChannelTypes(ChannelType.GuildText)
    .setMinValues(1)
    .setMaxValues(1);
  const api = new ButtonBuilder().setCustomId("aira:api").setLabel("ตั้งค่า Gemini API").setStyle(ButtonStyle.Primary);
  const models = new ButtonBuilder().setCustomId("aira:models").setLabel("ตั้งค่า Model").setStyle(ButtonStyle.Secondary);
  const refresh = new ButtonBuilder().setCustomId("aira:refresh").setLabel("รีเฟรช").setStyle(ButtonStyle.Success);
  const character = new ButtonBuilder().setCustomId("aira:character").setLabel("เพิ่ม / แก้ตัวละคร").setStyle(ButtonStyle.Secondary);
  return [
    new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(channel),
    new ActionRowBuilder<ButtonBuilder>().addComponents(api, models, character, refresh),
  ];
}

export async function publishControlPanel(client: Client): Promise<void> {
  try {
    if (!client.application) throw new Error("Discord application is not available yet");
    const application = await client.application.fetch();
    const owner = application.owner;
    if (!owner || !("id" in owner)) {
      console.warn("[PANEL] Cannot resolve application owner; control panel was not posted");
      return;
    }
    ownerId = "ownerId" in owner ? (owner.ownerId ?? owner.owner?.id ?? owner.id) : owner.id;
    const guilds = [...client.guilds.cache.values()];
    for (const guild of guilds) {
      const channels = await guild.channels.fetch();
      const canPost = (value: unknown): value is TextChannel => {
        const channel = value as TextChannel | null;
        return Boolean(
          channel
          && channel.isTextBased()
          && channel.permissionsFor(guild.members.me!)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages])
        );
      };
      const candidate = (canPost(guild.systemChannel) ? guild.systemChannel : null)
        ?? channels.find((channel): channel is TextChannel => canPost(channel));
      if (!candidate?.isTextBased() || !("send" in candidate)) continue;
      const recent = await candidate.messages.fetch({ limit: 30 }).catch(() => null);
      const existing = recent?.find((message) =>
        message.author.id === client.user?.id
        && message.embeds[0]?.title === "Aira • Control Panel"
      );
      if (existing) {
        await existing.edit({ embeds: [panelEmbed()], components: panelRows() });
      } else {
        await candidate.send({ embeds: [panelEmbed()], components: panelRows() });
      }
      console.log(`[PANEL] Control panel ready in #${candidate.name} (${guild.name})`);
      return;
    }
    console.warn("[PANEL] Bot is not in a guild with a writable text channel");
  } catch (error) {
    console.warn(`[PANEL] Could not publish control panel: ${String((error as Error)?.message ?? error)}`);
  }
}

export function getControlPanelOwnerId(): string | null { return ownerId; }

function isOwner(interaction: Interaction): boolean {
  return Boolean(ownerId && interaction.user.id === ownerId);
}

async function refreshPanel(interaction: Interaction): Promise<void> {
  if (!interaction.isMessageComponent()) return;
  await interaction.update({ embeds: [panelEmbed()], components: panelRows() });
}

export async function handleControlPanelInteraction(interaction: Interaction): Promise<boolean> {
  if (!interaction.isMessageComponent() && !interaction.isModalSubmit()) return false;
  const customId = interaction.customId;
  if (!customId.startsWith("aira:")) return false;
  if (!isOwner(interaction)) {
    if (interaction.isRepliable()) await interaction.reply({ content: "แผงควบคุมนี้ใช้ได้เฉพาะเจ้าของบอท", flags: MessageFlags.Ephemeral });
    return true;
  }

  if (interaction.isChannelSelectMenu() && customId === "aira:channel") {
    const selected = await interaction.guild?.channels.fetch(interaction.values[0]!);
    const permissions = selected && "permissionsFor" in selected ? selected.permissionsFor(interaction.guild!.members.me!) : null;
    if (!selected?.isTextBased() || !permissions?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages])) {
      await interaction.reply({ content: "บอทไม่มีสิทธิ์ดูหรือส่งข้อความในห้องนี้", flags: MessageFlags.Ephemeral });
      return true;
    }
    await setResponseChannelId(interaction.values[0]!);
    await interaction.update({ embeds: [panelEmbed()], components: panelRows() });
    return true;
  }

  if (interaction.isButton()) {
    if (customId === "aira:refresh") {
      await refreshPanel(interaction);
      return true;
    }
    const modal = new ModalBuilder()
      .setCustomId(customId === "aira:api" ? "aira:api-submit" : customId === "aira:models" ? "aira:models-submit" : "aira:character-submit")
      .setTitle(customId === "aira:api" ? "Gemini API Key" : customId === "aira:models" ? "Gemini Model Settings" : "Character Editor");
    if (customId === "aira:api") {
      const key = new TextInputBuilder()
        .setCustomId("keys")
        .setLabel("API key(s), คั่นด้วย comma")
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true)
        .setMaxLength(4000)
        .setPlaceholder("AIza...");
      modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(key));
    } else if (customId === "aira:models") {
      const settings = await readSettings();
      const gemini1 = new TextInputBuilder().setCustomId("gemini1").setLabel("Gemini 1 model").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(100).setValue(settings.gemini1Model ?? config.models.gemini1);
      const gemini2 = new TextInputBuilder().setCustomId("gemini2").setLabel("Gemini 2 model").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(100).setValue(settings.gemini2Model ?? config.models.gemini2);
      const embedding = new TextInputBuilder().setCustomId("embedding").setLabel("Embedding model").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(100).setValue(settings.embeddingModel ?? config.models.embedding2);
      modal.addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(gemini1),
        new ActionRowBuilder<TextInputBuilder>().addComponents(gemini2),
        new ActionRowBuilder<TextInputBuilder>().addComponents(embedding),
      );
    } else {
      const id = new TextInputBuilder().setCustomId("id").setLabel("Character ID (a-z, 0-9, _ or -)").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(32);
      const name = new TextInputBuilder().setCustomId("name").setLabel("ชื่อที่แสดง").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(80);
      const aliases = new TextInputBuilder().setCustomId("aliases").setLabel("ชื่อเรียกอื่น คั่นด้วย comma").setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(500);
      const prompt = new TextInputBuilder().setCustomId("prompt").setLabel("บุคลิก / System Prompt (เว้นว่างเพื่อคงค่าเดิม)").setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(4000);
      const enabled = new TextInputBuilder().setCustomId("enabled").setLabel("เปิดใช้งาน? true หรือ false").setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(5).setValue("true");
      modal.addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(id),
        new ActionRowBuilder<TextInputBuilder>().addComponents(name),
        new ActionRowBuilder<TextInputBuilder>().addComponents(aliases),
        new ActionRowBuilder<TextInputBuilder>().addComponents(prompt),
        new ActionRowBuilder<TextInputBuilder>().addComponents(enabled),
      );
    }
    await interaction.showModal(modal);
    return true;
  }

  if (interaction.isModalSubmit() && customId === "aira:api-submit") {
    const keys = interaction.fields.getTextInputValue("keys").split(",").map(value => value.trim()).filter(Boolean).join(",");
    if (!keys) {
      await interaction.reply({ content: "กรุณาใส่ API Key อย่างน้อยหนึ่งค่า", flags: MessageFlags.Ephemeral });
      return true;
    }
    const settings = await readSettings();
    settings.geminiApiKeys = keys;
    await saveSettings(settings);
    process.env.GEMINI_API_KEY = keys;
    process.env.GEMINI1_API_KEYS = keys;
    process.env.GEMINI2_API_KEYS = keys;
    process.env.GEMINI_EMBEDDING2_API_KEYS = keys;
    await interaction.reply({ content: "บันทึก Gemini API Key แล้ว สามารถเริ่มคุยกับ Aira ได้เลย", flags: MessageFlags.Ephemeral });
    if (interaction.message) await interaction.message.edit({ embeds: [panelEmbed()], components: panelRows() });
    return true;
  }

  if (interaction.isModalSubmit() && customId === "aira:character-submit") {
    const id = interaction.fields.getTextInputValue("id").trim().toLowerCase();
    const name = interaction.fields.getTextInputValue("name").trim();
    const aliases = interaction.fields.getTextInputValue("aliases").split(",").map(value => value.trim()).filter(Boolean);
    const prompt = interaction.fields.getTextInputValue("prompt").trim();
    const enabledInput = interaction.fields.getTextInputValue("enabled").trim().toLowerCase();
    if (!/^[a-z0-9_-]{1,32}$/.test(id) || !name) {
      await interaction.reply({ content: "Character ID ต้องเป็น a-z, 0-9, _ หรือ - และต้องมีชื่อ", flags: MessageFlags.Ephemeral });
      return true;
    }
    if (enabledInput && !["true", "false"].includes(enabledInput)) {
      await interaction.reply({ content: "ค่าเปิดใช้งานต้องเป็น true หรือ false", flags: MessageFlags.Ephemeral });
      return true;
    }
    if (id === "isla" && enabledInput === "false") {
      await interaction.reply({ content: "ไม่สามารถปิด Isla ได้ เพราะเป็นตัวละครหลักของระบบ", flags: MessageFlags.Ephemeral });
      return true;
    }
    const activeCharacters = loadCharacters().filter(character => character.id !== id);
    const incomingAliases = [name, ...aliases].map(value => value.toLocaleLowerCase());
    const existingAliases = new Set(activeCharacters.flatMap(character => character.aliases.map(value => value.toLocaleLowerCase())));
    if (incomingAliases.some(alias => existingAliases.has(alias))) {
      await interaction.reply({ content: "ชื่อหรือ alias นี้ถูกใช้โดยตัวละครอื่นแล้ว", flags: MessageFlags.Ephemeral });
      return true;
    }
    const definitionFile = resolve("characters", id + ".json");
    const promptFile = resolve("characters", "prompts", id + ".md");
    let existing: Record<string, unknown> = {};
    if (existsSync(definitionFile)) {
      try { existing = JSON.parse(readFileSync(definitionFile, "utf8")) as Record<string, unknown>; } catch {}
    }
    let promptText = prompt;
    if (!promptText && typeof existing.promptFile === "string") {
      try { promptText = readFileSync(resolve("characters", existing.promptFile), "utf8"); } catch {}
    }
    if (!promptText) {
      await interaction.reply({ content: "ตัวละครใหม่ต้องใส่ System Prompt ด้วย", flags: MessageFlags.Ephemeral });
      return true;
    }
    await mkdir(dirname(promptFile), { recursive: true });
    await writeFile(promptFile, promptText.trim() + "\n", "utf8");
    await writeFile(definitionFile, JSON.stringify({
      id,
      name,
      aliases,
      promptFile: "prompts/" + id + ".md",
      enabled: enabledInput ? enabledInput === "true" : existing.enabled !== false,
    }, null, 2) + "\n", "utf8");
    await interaction.reply({ content: "บันทึกตัวละคร " + name + " แล้ว การเพิ่ม/แก้ไขมีผลกับข้อความถัดไป", flags: MessageFlags.Ephemeral });
    if (interaction.message) await interaction.message.edit({ embeds: [panelEmbed()], components: panelRows() });
    return true;
  }

  if (interaction.isModalSubmit() && customId === "aira:models-submit") {
    const settings = await readSettings();
    settings.gemini1Model = interaction.fields.getTextInputValue("gemini1").trim();
    settings.gemini2Model = interaction.fields.getTextInputValue("gemini2").trim();
    settings.embeddingModel = interaction.fields.getTextInputValue("embedding").trim();
    await saveSettings(settings);
    config.models.gemini1 = settings.gemini1Model;
    config.models.gemini2 = settings.gemini2Model;
    config.models.embedding2 = settings.embeddingModel;
    await interaction.reply({ content: "บันทึก Model แล้ว มีผลกับคำขอถัดไป", flags: MessageFlags.Ephemeral });
    if (interaction.message) await interaction.message.edit({ embeds: [panelEmbed()], components: panelRows() });
    return true;
  }
  return true;
}
