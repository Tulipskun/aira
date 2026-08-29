import "dotenv/config";
import { Client, Events, GatewayIntentBits, type Message } from "discord.js";
import { MessageScheduler } from "../pipeline/scheduler.js";
import { handleCommand, isKnownCommand } from "./commands.js";
import { handleIslaCommand, ISLA_COMMAND_NAME } from "./interactions.js";
import { createOnFlush, toScheduledMessage } from "./message-handler.js";
import { startTypingLoop, type TypingIndicator } from "./typing.js";
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

// How many flushes are inside processMessage right now. Different users can be in flight
// at the same time, so this is a counter rather than a boolean.
let inFlight = 0;
let typing: TypingIndicator | undefined;

const scheduler = new MessageScheduler({
  debounceMs: 5_000,
  maxWaitMs: 12_000,
  onFlush: createOnFlush(client, (busy) => {
    inFlight = Math.max(0, inFlight + (busy ? 1 : -1));
    if (busy) typing?.poke();
  }),
});

// Show "Isla is typing…" while messages are waiting in the debounce queue or the pipeline
// is running, refreshed every 8s (Discord expires the indicator after ~10s).
typing = startTypingLoop(client, {
  channelId: getResponseChannelId,
  isActive: () => inFlight > 0 || scheduler.hasPending(),
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
  // Poke so the indicator shows immediately instead of waiting for the next 8s tick;
  // the loop's own min-gap throttle keeps a burst of messages from sending repeats.
  typing?.poke();
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

process.once("SIGINT", () => { typing?.stop(); scheduler.flushAll(); });
process.once("SIGTERM", () => { typing?.stop(); scheduler.flushAll(); });

client.once("ready", () => {
  console.log(`[DISCORD] Logged in as ${client.user?.tag ?? "unknown"}`);
  const channelId = getResponseChannelId();
  console.log(`[DISCORD] Response channel: ${channelId ?? "not set"}`);
});

await client.login(token);
