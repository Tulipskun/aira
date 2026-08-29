import "dotenv/config";
import { Client, Events, GatewayIntentBits, type Message } from "discord.js";
import { MessageScheduler } from "../pipeline/scheduler.js";
import { handleCommand, isKnownCommand } from "./commands.js";
import { handleIslaCommand, ISLA_COMMAND_NAME } from "./interactions.js";
import { createOnFlush, toScheduledMessage } from "./message-handler.js";
import { getResponseChannelId } from "./discord-config.js";

const token = process.env.ISLA_TOKEN;
const ownerId = process.env.DISCORD_OWNER_ID;
if (!token) throw new Error("ISLA_TOKEN is required");
if (!ownerId) throw new Error("DISCORD_OWNER_ID is required");

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

const scheduler = new MessageScheduler({
  debounceMs: 5_000,
  maxWaitMs: 12_000,
  onFlush: createOnFlush(client),
});

client.on("messageCreate", async (message: Message) => {
  if (message.author.bot) return;

  const text = message.content.trim();
  if (!text) return;

  if (text.startsWith("!")) {
    if (isKnownCommand(text)) await handleCommand(message, ownerId);
    return;
  }

  const responseChannelId = getResponseChannelId();
  if (!responseChannelId || message.channelId !== responseChannelId) return;

  const scheduled = toScheduledMessage(message);
  if (!scheduled) return;

  scheduler.interruptByOtherUser(scheduled.userId);
  scheduler.push(scheduled);
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand() || interaction.commandName !== ISLA_COMMAND_NAME) return;
  try {
    await handleIslaCommand(interaction);
  } catch (error) {
    // Never let a failed reply become an unhandled rejection: the interaction may already be
    // answered, so log only.
    console.error(`[DISCORD] /${ISLA_COMMAND_NAME} handler failed: ${String((error as Error)?.message ?? error)}`);
  }
});

process.once("SIGINT", () => scheduler.flushAll());
process.once("SIGTERM", () => scheduler.flushAll());

client.once("ready", () => {
  console.log(`[DISCORD] Logged in as ${client.user?.tag ?? "unknown"}`);
  const channelId = getResponseChannelId();
  console.log(`[DISCORD] Response channel: ${channelId ?? "not set"}`);
});

await client.login(token);
