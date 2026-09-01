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

// The receive path used to log nothing at all, so a quiet bot was undiagnosable: "nobody typed"
// and "the gateway stopped delivering events" produced identical logs. This counts every place an
// incoming message can stop and prints the tally when the channel has been silent for 5 minutes.
const liveness = createLiveness({
  // One probe for both the log line and /health, so a diagnosis and an auto-heal can never
  // disagree about whether she is listening.
  shards: () => shardReadiness(client),
  channel: () => getResponseChannelId(),
});

client.on("messageCreate", async (message: Message) => {
  liveness.note("seen");
  if (message.author.bot) return;
  liveness.note("nonBot");

  const text = message.content.trim();

  if (text.startsWith("!")) {
    liveness.note("command");
    if (isKnownCommand(text)) await handleCommand(message, ownerId);
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
  // Flush any *other* session's queue so the reply order matches the conversation. Keyed on the
  // session rather than the user: in a group room, a second speaker must not cut off the turn that
  // is about to answer the first one — their messages are merging into the same batch.
  scheduler.interruptOtherSessions(scheduled.sessionKey);
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

// Boot time, used for uptime and by the watchdog to tell a fresh process from a long-broken one.
const startedAt = Date.now();

// Started here rather than in `ready` on purpose: the supervisor must be able to reach this port
// while the gateway is still connecting, so "process alive, gateway down" stays distinguishable
// from "process gone". Until `ready` it honestly answers gatewayReady=false, and the watchdog's
// grace period is what keeps that from triggering a restart during boot.
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
  // Start after `ready`: before the gateway connects, `fetchStatus()` legitimately reports no
  // shards, and a startup line reading NOT-READY(0/0) would be a false alarm on every boot.
  liveness.start();
});

// Absorb this host's cold getaddrinfo stalls (see warmup.ts) before logging in, so the
// first user message does not pay for them. Costs ~10s of startup, which nobody waits
// on, and saves ~11s on the first reply, which everybody does. Runs before `login()` on
// purpose: the stall is per process, so whoever resolves first absorbs it — letting the
// gateway connection eat it would leave the embedding call still exposed.
const warm = await warmNetwork();
console.log(`[WARMUP] ${warm.stalls} DNS stall(s) absorbed in ${warm.lookups} lookups, ${warm.ms}ms`);

// Memories written before session scoping carry no `sessionKey`, and retrieval filters on that
// metadata — so an un-migrated collection is not "old memories still work", it is *no* memories
// ever matching. History is backfilled at its module load (sql/history.ts); this is the vector
// half of the same migration. Best-effort on purpose: Chroma is started by the daemon before this
// process, but if it is unreachable the bot must still come online rather than crash-loop, and the
// next boot retries (the migration is idempotent).
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
