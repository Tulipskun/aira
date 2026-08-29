import "dotenv/config";
import { Client, EmbedBuilder, GatewayIntentBits, type Message } from "discord.js";
import { processMessage } from "./pipeline.js";
import { MessageScheduler, type ScheduledMessage } from "./scheduler.js";
import { fetchEmotionImage } from "./images.js";
import { getResponseChannelId, setResponseChannelId, unsetResponseChannelId } from "./discord_config.js";

const token = process.env.DISCORD_TOKEN;
const ownerId = process.env.DISCORD_OWNER_ID;
if (!token) throw new Error("DISCORD_TOKEN is required");
if (!ownerId) throw new Error("DISCORD_OWNER_ID is required");

const VALID_COMMANDS = new Set(["islacomehere", "unset"]);

function commandName(text: string): string {
  return text.slice(1).trim().split(/\s+/, 1)[0]?.toLowerCase() ?? "";
}

async function handleCommand(message: Message): Promise<void> {
  if (message.author.id !== ownerId) return;

  switch (commandName(message.content)) {
    case "islacomehere":
      await setResponseChannelId(message.channelId);
      await message.reply("Locked to this channel.");
      return;
    case "unset":
      await unsetResponseChannelId();
      await message.reply("Channel lock removed.");
      return;
  }
}

function toScheduledMessage(message: Message): ScheduledMessage | null {
  const text = message.content.trim();
  if (!text) return null;

  return {
    userId: message.author.id,
    user: message.author.username,
    text,
    timestamp: new Date(message.createdTimestamp).toISOString(),
    fileName: message.attachments.first()?.name ?? undefined,
    channelId: message.channelId,
  };
}

const scheduler = new MessageScheduler({
  debounceMs: 5_000,
  maxWaitMs: 12_000,
  onFlush: async (messages) => {
    if (!messages.length) return;

    const responseChannelId = getResponseChannelId();
    if (!responseChannelId) return;
    if (messages[0].channelId !== responseChannelId) return;

    const input = messages.reduce(
      (text, message) => (text ? `${text}\n${message.user}: ${message.text}` : `${message.user}: ${message.text}`),
      "",
    );

    const first = messages[0];
    const result = await processMessage({
      userId: first.userId,
      user: first.user,
      text: input,
      timestamp: first.timestamp,
      fileName: first.fileName,
    });

    const channel = await client.channels.fetch(responseChannelId);
    if (!channel?.isTextBased()) return;

    const image = await fetchEmotionImage(result.image);
    const embed = new EmbedBuilder()
      .setDescription(result.text)
      .setFooter({ text: "Isla" });

    if (image && result.image) {
      embed.setImage(`attachment://${result.image}`);
    }

    await channel.send({
      embeds: [embed],
      ...(image && result.image ? { files: [{ attachment: image, name: result.image }] } : {}),
    });
  },
});

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.on("messageCreate", async (message) => {
  if (message.author.bot) return;

  const text = message.content.trim();
  if (!text) return;

  if (text.startsWith("!")) {
    if (VALID_COMMANDS.has(commandName(text))) await handleCommand(message);
    return;
  }

  const responseChannelId = getResponseChannelId();
  if (!responseChannelId || message.channelId !== responseChannelId) return;

  const scheduled = toScheduledMessage(message);
  if (!scheduled) return;

  scheduler.interruptByOtherUser(scheduled.userId);
  scheduler.push(scheduled);
});

process.once("SIGINT", () => scheduler.flushAll());
process.once("SIGTERM", () => scheduler.flushAll());

client.once("ready", () => {
  console.log(`[DISCORD] Logged in as ${client.user?.tag ?? "unknown"}`);
  const channelId = getResponseChannelId();
  console.log(`[DISCORD] Response channel: ${channelId ?? "not set"}`);
});

await client.login(token);
