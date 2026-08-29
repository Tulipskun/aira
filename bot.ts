import "dotenv/config";
import { Client, GatewayIntentBits, type Message } from "discord.js";
import { processMessage } from "./pipeline.js";
import { MessageScheduler, type ScheduledMessage } from "./scheduler.js";

const token = process.env.DISCORD_TOKEN;
if (!token) throw new Error("DISCORD_TOKEN is required");

const VALID_COMMANDS = new Set(["islacomehere", "unset"]);

function isCommand(text: string): boolean {
  if (!text.startsWith("!")) return false;
  const name = text.slice(1).trim().split(/\s+/, 1)[0]?.toLowerCase() ?? "";
  return VALID_COMMANDS.has(name);
}

async function handleCommand(message: Message): Promise<void> {
  const name = message.content.slice(1).trim().split(/\s+/, 1)[0]?.toLowerCase() ?? "";

  switch (name) {
    case "islacomehere":
      // Command behavior can be added without changing message filtering.
      return;
    case "unset":
      // Command behavior can be added without changing message filtering.
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
  };
}

const scheduler = new MessageScheduler({
  debounceMs: 5_000,
  maxWaitMs: 12_000,
  onFlush: async (messages) => {
    if (!messages.length) return;

    const input = messages.reduce(
      (text, message) => (text ? `${text}\n${message.user}: ${message.text}` : `${message.user}: ${message.text}`),
      "",
    );

    const first = messages[0];
    await processMessage({
      userId: first.userId,
      user: first.user,
      text: input,
      timestamp: first.timestamp,
      fileName: first.fileName,
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
    if (isCommand(text)) await handleCommand(message);
    return;
  }

  const scheduled = toScheduledMessage(message);
  if (!scheduled) return;

  scheduler.interruptByOtherUser(scheduled.userId);
  scheduler.push(scheduled);
});

process.once("SIGINT", () => scheduler.flushAll());
process.once("SIGTERM", () => scheduler.flushAll());

client.once("ready", () => {
  console.log(`[DISCORD] Logged in as ${client.user?.tag ?? "unknown"}`);
});

await client.login(token);
