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
import { dirname, resolve } from "node:path";
import { setResponseChannelId, getResponseChannelId } from "./discord-config.js";
import { config } from "../config.js";

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
      "เลือกช่องตอบกลับ แล้วเพิ่ม Gemini API Key เพื่อเริ่มใช้งาน AI",
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
  return [
    new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(channel),
    new ActionRowBuilder<ButtonBuilder>().addComponents(api, models, refresh),
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
      .setCustomId(customId === "aira:api" ? "aira:api-submit" : "aira:models-submit")
      .setTitle(customId === "aira:api" ? "Gemini API Key" : "Gemini Model Settings");
    if (customId === "aira:api") {
      const key = new TextInputBuilder()
        .setCustomId("keys")
        .setLabel("API key(s), คั่นด้วย comma")
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true)
        .setMaxLength(4000)
        .setPlaceholder("AIza...");
      modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(key));
    } else {
      const settings = await readSettings();
      const gemini1 = new TextInputBuilder().setCustomId("gemini1").setLabel("Gemini 1 model").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(100).setValue(settings.gemini1Model ?? config.models.gemini1);
      const gemini2 = new TextInputBuilder().setCustomId("gemini2").setLabel("Gemini 2 model").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(100).setValue(settings.gemini2Model ?? config.models.gemini2);
      const embedding = new TextInputBuilder().setCustomId("embedding").setLabel("Embedding model").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(100).setValue(settings.embeddingModel ?? config.models.embedding2);
      modal.addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(gemini1),
        new ActionRowBuilder<TextInputBuilder>().addComponents(gemini2),
        new ActionRowBuilder<TextInputBuilder>().addComponents(embedding),
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
