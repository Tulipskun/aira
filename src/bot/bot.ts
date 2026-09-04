import "dotenv/config";
import { Client, Events, GatewayIntentBits, type Message } from "discord.js";
import { MessageScheduler } from "../pipeline/scheduler.js";
import { handleCommand, isKnownCommand } from "./commands.js";
import { handleIslaCommand, ISLA_COMMAND_NAME } from "./interactions.js";
import { createOnFlush, toScheduledMessage } from "./message-handler.js";
import { startTypingLoop, type TypingIndicator } from "./typing.js";
import { createLiveness } from "./liveness.js";
import { shardReadiness, startHealthServer } from "./health.js";
import { warmNetwork } from "./warmup.js";
import { getResponseChannelId } from "./discord-config.js";
import { migrateMemorySessions } from "../memory/chroma.js";
import { LEGACY_SESSION_KEY } from "../session-keys.js";
import { config } from "../config.js";

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
let warnedEmptyMessageContent = false;

const scheduler = new MessageScheduler({
  debounceMs: 5_000,
  maxWaitMs: 12_000,
  onFlush: createOnFlush(client, (busy) => {
    inFlight = Math.max(0, inFlight + (busy ? 1 : -1));
    if (busy) typing?.poke();
  }, {
    pause: async () => { await typing?.pause(); },
    resume: () => { typing?.resume(); },
  }),
});

typing = startTypingLoop(client, {
  channelId: getResponseChannelId,
  isActive: () => inFlight > 0 || scheduler.hasPending(),
});

const liveness = createLiveness({
  shards: () => shardReadiness(client),
  channel: () => getResponseChannelId(),
});

client.on("messageCreate", async (message: Message) => {
  liveness.note("seen");
  if (message.author.bot) return;
  liveness.note("nonBot");

  const text = message.content.trim();

  if (!text && !warnedEmptyMessageContent) {
    warnedEmptyMessageContent = true;
    console.warn("[DISCORD] Received a non-bot message with empty content; prefix commands such as !islacomehere cannot be parsed. Check the Message Content privileged intent in the Discord Developer Portal.");
  }

  if (text.startsWith("!")) {
    liveness.note("command");
    console.log(`[DISCORD] Prefix command received: ${commandForLog(text)}`);
    if (isKnownCommand(text)) await handleCommand(message, ownerId);
    else console.log(`[DISCORD] Unknown prefix command ignored: ${commandForLog(text)}`);
    return;
  }

  const responseChannelId = getResponseChannelId();
  if (!responseChannelId || message.channelId !== responseChannelId) {
    liveness.note("offChannel");
    return;
  }

  const scheduled = toScheduledMessage(message);
  if (!scheduled) {
    liveness.note("dropped");
    return;
  }

  liveness.note("queued");
  scheduler.interruptOtherSessions(scheduled.sessionKey);
  scheduler.push(scheduled);
  typing?.poke();
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand() || interaction.commandName !== ISLA_COMMAND_NAME) return;
  try {
    await handleIslaCommand(interaction);
  } catch (error) {
    console.error(`[DISCORD] /${ISLA_COMMAND_NAME} handler failed: ${String((error as Error)?.message ?? error)}`);
  }
});

const startedAt = Date.now();

const health = startHealthServer({
  client,
  liveness,
  channel: () => getResponseChannelId(),
  startedAt,
  port: config.health.port,
});
console.log(`[HEALTH] listening on ${health.url}`);

process.once("SIGINT", () => { typing?.stop(); liveness.stop(); health.stop(); scheduler.flushAll(); });
process.once("SIGTERM", () => { typing?.stop(); liveness.stop(); health.stop(); scheduler.flushAll(); });

client.once("ready", () => {
  console.log(`[DISCORD] Logged in as ${client.user?.tag ?? "unknown"}`);
  const channelId = getResponseChannelId();
  console.log(`[DISCORD] Response channel: ${channelId ?? "not set"}`);
  liveness.start();
});

const warm = await warmNetwork();
console.log(`[WARMUP] ${warm.stalls} DNS stall(s) absorbed in ${warm.lookups} lookups, ${warm.ms}ms`);

try {
  const migrated = await migrateMemorySessions();
  if (migrated.backfilled) {
    console.log(`[SESSIONS] memories backfilled: ${migrated.backfilled} keyed` +
      (migrated.unattributed ? `, ${migrated.unattributed} unattributable -> ${LEGACY_SESSION_KEY}` : ""));
  } else {
    console.log(`[SESSIONS] memories already keyed (${migrated.alreadyKeyed})`);
  }
} catch (error) {
  console.warn(`[SESSIONS] memory backfill skipped: ${String((error as Error)?.message ?? error)} -- memories stay unscoped until the next boot`);
}

await client.login(token);

function commandForLog(text: string): string {
  const name = text.slice(1).trim().split(/\s+/, 1)[0]?.toLowerCase() ?? "";
  return name || "<empty>";
}
