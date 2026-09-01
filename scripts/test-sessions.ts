/**
 * Session scope: the registry, the history backfill, and the /isla subcommands that drive them.
 *
 *   bun run scripts/test-sessions.ts
 *
 * Fully offline — no Discord calls, no Gemini quota. `SQLITE_PATH` and `DISCORD_CONFIG_PATH` are
 * pointed at a temp directory *before* the modules are imported, because both open their file at
 * module load; importing `interactions.js` pulls in `discord-config.js`, and a test that forgot the
 * override would read the real response channel out of `.aira/discord-config.json`.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { MessageFlags } from "discord.js";
import type { ScheduledMessage } from "../src/pipeline/scheduler.js";

let pass = 0;
let fail = 0;
// `seen` mirrors test-profile.ts's check(): a failing assertion prints what it actually got, which
// is the difference between "the room merged nothing" and being able to see why.
function check(label: string, cond: boolean, seen?: unknown): void {
  console.log(`  ${cond ? "✅" : "❌"} ${label}${cond || seen === undefined ? "" : ` -- got: ${JSON.stringify(seen)}`}`);
  cond ? pass++ : fail++;
}

const dir = mkdtempSync(join(tmpdir(), "aira-sessions-test-"));
const dbPath = join(dir, "test.db");
const configPath = join(dir, "discord-config.json");
// The room used throughout IS the locked response channel, so "join a room she answers in" is
// the normal case; OTHER_ROOM is the one that must warn.
const RESPONSE_CHANNEL = "200000000000000000";
writeFileSync(configPath, JSON.stringify({ responseChannelId: RESPONSE_CHANNEL }, null, 2) + "\n");
process.env.SQLITE_PATH = dbPath;
process.env.DISCORD_CONFIG_PATH = configPath;

const keys = await import("../src/session-keys.js");
const sessions = await import("../src/sql/sessions.js");

/* ------------------------------------------------------------------ *
 * 1. Key shapes
 * ------------------------------------------------------------------ */
console.log("=== 1. session key shapes ===");
check("user key", sessions.userSessionKey("111") === "user:111");
check("group key", sessions.groupSessionKey("222") === "group:222");
check("isGroupSession only true for group:", sessions.isGroupSession("group:222") && !sessions.isGroupSession("user:111"));
check("isUserSession only true for user:", sessions.isUserSession("user:111") && !sessions.isUserSession("group:222"));
check("groupChannelOf round-trips", sessions.groupChannelOf(sessions.groupSessionKey("222")) === "222");
check("groupChannelOf null for private", sessions.groupChannelOf(sessions.userSessionKey("111")) === null);
check("userOfSession round-trips", sessions.userOfSession(sessions.userSessionKey("111")) === "111");
check("userOfSession null for group", sessions.userOfSession(sessions.groupSessionKey("222")) === null);
// A key is a routing label, not a path: nothing here may be interpretable as one.
check("a colon inside an id still parses as one field", sessions.userOfSession("user:a:b") === "a:b");
check("legacy bucket is neither user nor group", keys.LEGACY_SESSION_KEY === "legacy:unattributed"
  && !keys.isUserSession(keys.LEGACY_SESSION_KEY) && !keys.isGroupSession(keys.LEGACY_SESSION_KEY));

/* ------------------------------------------------------------------ *
 * 2. The registry — join / move / leave
 * ------------------------------------------------------------------ */
console.log("=== 2. registry: default is private ===");
const ALICE = "100000000000000001";
const BOB = "100000000000000002";
const ROOM = RESPONSE_CHANNEL;
const OTHER_ROOM = "200000000000000001";

check("no membership before joining", sessions.groupMembership(ALICE) === null);
check("default session is the user's own", sessions.sessionKeyFor(ALICE, ROOM) === `user:${ALICE}`);
check("a message with no channel is private too", sessions.sessionKeyFor(ALICE, null) === `user:${ALICE}`);
check("nobody is in the room yet", sessions.groupMembers(ROOM).length === 0);

console.log("=== 3. join-group ===");
const joined = sessions.joinGroup(ALICE, ROOM);
check("first join reports joined", joined.status === "joined");
check("no previous room to name", joined.previousChannel === undefined);
check("current names the room", joined.current.channelId === ROOM && joined.current.userId === ALICE);
check("joined_at is an ISO timestamp", /^\d{4}-\d{2}-\d{2}T/.test(joined.current.joinedAt));
check("membership now readable", sessions.groupMembership(ALICE)?.channelId === ROOM);
check("messages in that room are shared", sessions.sessionKeyFor(ALICE, ROOM) === `group:${ROOM}`);
// The stale-join rule: joining in A must not silently share a conversation happening in B.
check("writing elsewhere stays private", sessions.sessionKeyFor(ALICE, OTHER_ROOM) === `user:${ALICE}`);
check("and the membership is left alone by that", sessions.groupMembership(ALICE)?.channelId === ROOM);

const again = sessions.joinGroup(ALICE, ROOM);
check("re-joining the same room is 'already'", again.status === "already");
check("'already' preserves joined_at", again.current.joinedAt === joined.current.joinedAt);

const moved = sessions.joinGroup(ALICE, OTHER_ROOM);
check("joining a second room reports moved", moved.status === "moved");
check("and names the room left behind", moved.previousChannel === ROOM);
check("one membership at a time", sessions.groupMembership(ALICE)?.channelId === OTHER_ROOM);
check("the old room no longer routes her", sessions.sessionKeyFor(ALICE, ROOM) === `user:${ALICE}`);
check("the new room does", sessions.sessionKeyFor(ALICE, OTHER_ROOM) === `group:${OTHER_ROOM}`);

console.log("=== 4. members ===");
sessions.joinGroup(BOB, ROOM);
const members = sessions.groupMembers(ROOM);
check("room has Alice back after she moved away? no — only Bob", members.length === 1 && members[0].userId === BOB);
check("other room has Alice", sessions.groupMembers(OTHER_ROOM).map((m) => m.userId).join() === ALICE);
const everyone = sessions.allGroupMembers();
check("allGroupMembers lists both rooms", everyone.length === 2 && everyone.every((m) => m.joinedAt.length > 0));
check("sorted by channel then arrival", everyone[0].channelId <= everyone[everyone.length - 1].channelId);

console.log("=== 5. leave-group ===");
const left = sessions.leaveGroup(ALICE);
check("leaving returns what was left", left?.channelId === OTHER_ROOM && left?.userId === ALICE);
check("membership gone", sessions.groupMembership(ALICE) === null);
check("back to a private stream", sessions.sessionKeyFor(ALICE, OTHER_ROOM) === `user:${ALICE}`);
check("leaving again is a no-op, not an error", sessions.leaveGroup(ALICE) === null);
check("room is empty now", sessions.groupMembers(OTHER_ROOM).length === 0);

/* ------------------------------------------------------------------ *
 * 6. Persistence across a restart
 * ------------------------------------------------------------------ */
console.log("=== 6. persistence across restart ===");
sessions.joinGroup(ALICE, ROOM);
const joinedAtBeforeRestart = sessions.groupMembership(ALICE)?.joinedAt;
// A second connection to the same file, while the first stays open: that is what proves the
// membership lives on disk rather than in a module's memory, which is the whole restart question.
// (It also must not close the first connection — `interactions.ts` imports that instance, and a
// closed handle there fails with "Database has closed" rather than testing anything.)
const reopened = await import(`../src/sql/sessions.js?restart=${Date.now()}`);
check("membership survived", reopened.groupMembership(ALICE)?.channelId === ROOM);
check("routing survived", reopened.sessionKeyFor(ALICE, ROOM) === `group:${ROOM}`);
check("joined_at survived", reopened.groupMembership(ALICE)?.joinedAt === joinedAtBeforeRestart);
check("the original connection still sees it too", sessions.groupMembership(ALICE)?.channelId === ROOM);
reopened.closeSessionsDb();

/* ------------------------------------------------------------------ *
 * 7. History backfill — the old global stream becomes per-session
 * ------------------------------------------------------------------ */
console.log("=== 7. history backfill ===");
const legacyPath = join(dir, "legacy.db");
{
  const raw = new Database(legacyPath);
  // The pre-session shape, verbatim: no session_key column, and Isla's replies with user_id NULL.
  raw.run(`CREATE TABLE messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    role TEXT NOT NULL CHECK (role IN ('user', 'model')),
    user_id TEXT, user_name TEXT, text TEXT NOT NULL, timestamp TEXT NOT NULL, file_name TEXT
  )`);
  const insert = raw.prepare(`INSERT INTO messages (role, user_id, user_name, text, timestamp) VALUES (?, ?, ?, ?, ?)`);
  insert.run("model", null, null, "คำทักทายก่อนมีเจ้าของ", "2026-01-01T00:00:00.000Z");
  insert.run("user", ALICE, "Alice", " alice พูด", "2026-01-02T00:00:00.000Z");
  insert.run("model", null, null, " alice ตอบ", "2026-01-02T00:00:01.000Z");
  insert.run("user", BOB, "Bob", " bob พูด", "2026-01-03T00:00:00.000Z");
  insert.run("model", null, null, " bob ตอบ", "2026-01-03T00:00:01.000Z");
  insert.run("model", null, null, " model ต่อท้ายของ bob", "2026-01-03T00:00:02.000Z");
  raw.close();
}
process.env.SQLITE_PATH = legacyPath;
const history = await import(`../src/sql/history.js?legacy=${Date.now()}`);
const aliceKey = keys.userSessionKey(ALICE);
const bobKey = keys.userSessionKey(BOB);
// A model row inherits the last user who spoke, so each person keeps the exchange they actually had.
check("alice keeps her reply", history.getHistory(50, aliceKey).map((r: { text: string }) => r.text).join("|") === " alice พูด| alice ตอบ");
check("bob keeps his", history.getHistory(50, bobKey).map((r: { text: string }) => r.text).join("|") === " bob พูด| bob ตอบ| model ต่อท้ายของ bob");
// The leading reply had no author to inherit from: filed away, not handed to the first person who asks.
check("unattributable row is in the legacy bucket", history.getHistory(50, history.LEGACY_SESSION_KEY).length === 1);
check("and it is not in alice's window", !history.getHistory(50, aliceKey).some((r: { text: string }) => r.text.startsWith("คำทักทาย")));
check("rows carry their key on read", history.getHistory(1, bobKey)[0].sessionKey === bobKey);
// Idempotence: the module already ran it once at import; a second call must change nothing.
const second = history.migrateMessageSessions();
check("second backfill writes nothing", second.backfilled === 0);
check("and reports what is already keyed", second.alreadyKeyed === 6);
check("history unchanged after re-running", history.getHistory(50, bobKey).length === 3);

console.log("=== 8. getHistory is scoped, limit still newest-first ===");
history.saveMessage({ role: "user", userId: ALICE, user: "Alice", text: "g1", timestamp: "2026-02-01T00:00:00.000Z", sessionKey: `group:${ROOM}` });
history.saveMessage({ role: "user", userId: BOB, user: "Bob", text: "g2", timestamp: "2026-02-01T00:00:01.000Z", sessionKey: `group:${ROOM}` });
const groupRows = history.getHistory(50, `group:${ROOM}`);
check("both speakers share the room's window", groupRows.map((r: { text: string }) => r.text).join("|") === "g1|g2");
check("a private window does not see the room", history.getHistory(50, aliceKey).length === 2);
check("the room does not see private turns", groupRows.every((r: { text: string }) => r.text.startsWith("g")));
check("limit keeps the NEWEST rows", history.getHistory(1, `group:${ROOM}`)[0].text === "g2");
check("listMessages filters by session", history.listMessages({ sessionKey: `group:${ROOM}` }).length === 2);
check("listMessages filters by session + user", history.listMessages({ sessionKey: `group:${ROOM}`, userId: ALICE }).length === 1);
check("countMessages honours the session filter", history.countMessages({ sessionKey: `group:${ROOM}` }) === 2);
history.closeHistoryDb();
process.env.SQLITE_PATH = dbPath;

/* ------------------------------------------------------------------ *
 * 9. /isla subcommands
 * ------------------------------------------------------------------ */
console.log("=== 9. /isla subcommands ===");
const { handleIslaCommand, ISLA_COMMAND_NAME, ISLA_SUBCOMMANDS, islaCommandPayload, ISLA_ARGS_OPTION } = await import("../src/bot/interactions.js");

type Sent = Record<string, any>;
function fakeInteraction(options: {
  sub?: string | null;
  args?: string | null;
  channelId?: string | null;
  userId?: string;
}) {
  const sent: Sent[] = [];
  const interaction = {
    channelId: options.channelId === undefined ? ROOM : options.channelId,
    user: { id: options.userId ?? ALICE },
    options: {
      getSubcommand: (_required?: boolean) => options.sub ?? null,
      getString: (name: string) => (name === ISLA_ARGS_OPTION ? (options.args ?? null) : null),
    },
    reply: async (payload: Sent) => { sent.push(payload); },
  };
  return { interaction: interaction as any, sent };
}

function content(sent: Sent[]): string { return String(sent[0]?.content ?? ""); }

// Start this section from a known state: Alice is in ROOM (from §6), Bob is private.
sessions.leaveGroup(ALICE);
sessions.leaveGroup(BOB);

{
  const { interaction, sent } = fakeInteraction({ sub: ISLA_SUBCOMMANDS.joinGroup, userId: ALICE });
  await handleIslaCommand(interaction);
  check("join-group wrote the membership", sessions.groupMembership(ALICE)?.channelId === ROOM);
  check("join-group replied once", sent.length === 1);
  check("reply is ephemeral", sent[0].flags === MessageFlags.Ephemeral);
  check("mentions are not parseable", JSON.stringify(sent[0].allowedMentions) === '{"parse":[]}');
  check("names the room joined", content(sent).includes(ROOM));
  check("explains what sharing means", content(sent).includes("ประวัติ"));
  check("no stale-join warning when the room is the response channel", !content(sent).includes("เธอยังไม่ถูกอ่าน"));
}
{
  // Same room again must say "already here", not pretend she just arrived.
  const { interaction, sent } = fakeInteraction({ sub: ISLA_SUBCOMMANDS.joinGroup, userId: ALICE });
  await handleIslaCommand(interaction);
  check("re-join says already in this room", content(sent).includes("อยู่ในห้องรวมนี้แล้ว"));
}
{
  // A room that is not the locked response channel must warn — joining it changes nothing she sees.
  const { interaction, sent } = fakeInteraction({ sub: ISLA_SUBCOMMANDS.joinGroup, userId: BOB, channelId: OTHER_ROOM });
  await handleIslaCommand(interaction);
  check("joining a non-response room warns", content(sent).includes("เธอยังไม่ถูกอ่าน"));
  check("and still records the join", sessions.groupMembership(BOB)?.channelId === OTHER_ROOM);
  const { interaction: moved, sent: movedSent } = fakeInteraction({ sub: ISLA_SUBCOMMANDS.joinGroup, userId: BOB, channelId: ROOM });
  await handleIslaCommand(moved);
  check("moving rooms reports where she came from", content(movedSent).includes(OTHER_ROOM) && content(movedSent).includes("ย้ายมาจาก"));
}
{
  const { interaction, sent } = fakeInteraction({ sub: ISLA_SUBCOMMANDS.leaveGroup, userId: BOB });
  await handleIslaCommand(interaction);
  check("leave-group cleared the row", sessions.groupMembership(BOB) === null);
  check("leave-group names the room left", content(sent).includes(ROOM));
  const { interaction: again, sent: againSent } = fakeInteraction({ sub: ISLA_SUBCOMMANDS.leaveGroup, userId: BOB });
  await handleIslaCommand(again);
  check("leaving while private is informational, not an error", content(againSent).includes("ไม่ได้อยู่ในเซสชันรวม") && !content(againSent).startsWith("❌"));
}
{
  const { interaction, sent } = fakeInteraction({ sub: ISLA_SUBCOMMANDS.status, userId: ALICE });
  await handleIslaCommand(interaction);
  check("status shows the group key", content(sent).includes(`group:${ROOM}`));
  check("status says it is shared", content(sent).includes("รวม"));
  check("status does not list herself as someone else", !content(sent).includes(`<@${ALICE}>`));
  check("status shows an empty room honestly", content(sent).includes("ไม่มี"));
  sessions.joinGroup(BOB, ROOM);
  const { interaction: withBob, sent: withBobSent } = fakeInteraction({ sub: ISLA_SUBCOMMANDS.status, userId: ALICE });
  await handleIslaCommand(withBob);
  check("status lists the other member", content(withBobSent).includes("<@" + BOB));
  check("and counts them", content(withBobSent).includes("(1)"));
  // Joined elsewhere → the next message is private, and status must predict that.
  const { interaction: elsewhere, sent: elsewhereSent } = fakeInteraction({ sub: ISLA_SUBCOMMANDS.status, userId: ALICE, channelId: OTHER_ROOM });
  await handleIslaCommand(elsewhere);
  check("status predicts a private session outside the room", content(elsewhereSent).includes(`user:${ALICE}`));
  check("and warns that the join is elsewhere", content(elsewhereSent).includes(ROOM));
}
{
  const { interaction, sent } = fakeInteraction({ sub: ISLA_SUBCOMMANDS.say, args: "ทดสอบ `โค้ด`\nขึ้นบรรทัดใหม่", userId: ALICE });
  await handleIslaCommand(interaction);
  check("say echoes the text", content(sent).includes("ทดสอบ"));
  check("backticks neutralised", !content(sent).includes("`"));
  check("newlines flattened", !content(sent).includes("\n"));
  check("say changes no session", sessions.groupMembership(ALICE)?.channelId === ROOM);
  const { interaction: long, sent: longSent } = fakeInteraction({ sub: ISLA_SUBCOMMANDS.say, args: "ย".repeat(500), userId: ALICE });
  await handleIslaCommand(long);
  check("overlong args clipped", content(longSent).length < 300 && content(longSent).includes("…"));
  const { interaction: empty, sent: emptySent } = fakeInteraction({ sub: ISLA_SUBCOMMANDS.say, args: "   ", userId: ALICE });
  await handleIslaCommand(empty);
  check("blank args still acknowledged", content(emptySent).includes("ได้รับคำสั่งแล้ว") && !content(emptySent).includes(":"));
}
{
  // A client that sends the retired bare form must still get an acknowledgement, not silence.
  const { interaction, sent } = fakeInteraction({ sub: null, args: "เดิม", userId: ALICE });
  await handleIslaCommand(interaction);
  check("no subcommand falls through to say", content(sent).includes("เดิม"));
  const { interaction: unknown, sent: unknownSent } = fakeInteraction({ sub: "not-a-subcommand", userId: ALICE });
  await handleIslaCommand(unknown);
  check("unknown subcommand still replies ephemerally", unknownSent.length === 1 && unknownSent[0].flags === MessageFlags.Ephemeral);
}
{
  // DMs and guild-text-channel-less interactions have no room to join.
  sessions.leaveGroup(ALICE);
  const { interaction, sent } = fakeInteraction({ sub: ISLA_SUBCOMMANDS.joinGroup, channelId: null, userId: ALICE });
  await handleIslaCommand(interaction);
  check("join-group without a channel refuses", content(sent).startsWith("❌"));
  check("and writes nothing", sessions.groupMembership(ALICE) === null);
}

/* ------------------------------------------------------------------ *
 * 10. The registered payload matches the handler
 * ------------------------------------------------------------------ */
console.log("=== 10. payload ↔ handler ===");
const payload = islaCommandPayload();
const optionNames = (payload.options ?? []).map((option) => option.name);
check("command name is what bot.ts routes on", payload.name === ISLA_COMMAND_NAME);
for (const sub of Object.values(ISLA_SUBCOMMANDS)) {
  check(`every handled subcommand is registered: ${sub}`, optionNames.includes(sub));
}
check("nothing registered that the handler does not know", optionNames.every((name) => (Object.values(ISLA_SUBCOMMANDS) as string[]).includes(name)));
// Discord 400 / code 50035: a subcommand option cannot sit beside any other option type.
check("no top-level option besides subcommands", (payload.options ?? []).every((option: any) => option.type === 1));
check("args lives only under say", (payload.options ?? []).every((option: any) =>
  option.name === ISLA_SUBCOMMANDS.say ? true : (option.options ?? []).length === 0));
check("say carries args", ((payload.options ?? []).find((option: any) => option.name === ISLA_SUBCOMMANDS.say)?.options ?? [])
  .some((option: any) => option.name === ISLA_ARGS_OPTION && option.type === 3));
check("args is optional everywhere", ((payload.options ?? []).find((option: any) => option.name === ISLA_SUBCOMMANDS.say)?.options ?? [])
  .every((option: any) => option.required !== true));
check("join-group needs no argument (the room is the channel it was used in)",
  (payload.options ?? []).find((option: any) => option.name === ISLA_SUBCOMMANDS.joinGroup)?.options === undefined);
check("every subcommand has a Thai description", (payload.options ?? []).every((option: any) =>
  typeof option.description === "string" && option.description.length > 10 && /[ก-๙]/.test(option.description)));

console.log("=== 11. wiring (source greps) ===");
const registerSource = readFileSync(join(import.meta.dirname, "register-commands.ts"), "utf8");
const botSource = readFileSync(join(import.meta.dirname, "../src/bot/bot.ts"), "utf8");
const handlerSource = readFileSync(join(import.meta.dirname, "../src/bot/message-handler.ts"), "utf8");
check("registration builds its payload from the handler module", registerSource.includes("islaCommandPayload()"));
check("registration does not hand-copy subcommand names", !/name:\s*["']join-group["']/.test(registerSource));
check("registration preserves other commands (PUT is replace-all)", registerSource.includes("others"));
check("bot.ts routes interactions to the handler", botSource.includes("handleIslaCommand(interaction)"));
check("the receive path resolves the session key", handlerSource.includes("sessionKey: sessionKeyFor(message.author.id, message.channelId)"));
check("batches are keyed by session, not user", !handlerSource.includes("interruptByOtherUser"));

/* ------------------------------------------------------------------ *
 * 12. Memory scoping (Chroma) — skipped when the server is not up
 * ------------------------------------------------------------------ */
console.log("=== 12. memory scoping ===");
const chromaUrl = process.env.CHROMA_URL ?? "http://127.0.0.1:8000";
let chromaUp = false;
try {
  const probe = await fetch(`${chromaUrl.replace(/\/$/, "")}/api/v2/heartbeat`, { signal: AbortSignal.timeout(2000) });
  chromaUp = probe.ok;
} catch { chromaUp = false; }

if (!chromaUp) {
  console.log("  ⏭  skipped: Chroma not reachable — start the stack to cover this section");
} else {
  // A collection of its own, and hand-made vectors: no Gemini quota, and the real
  // `aira_memories` is never touched.
  process.env.CHROMA_COLLECTION = "aira_sessions_test";
  const { ChromaClient } = await import("chromadb");
  const chroma = new ChromaClient({ host: new URL(chromaUrl).hostname, port: Number(new URL(chromaUrl).port || 80), ssl: new URL(chromaUrl).protocol === "https:" });
  try { await chroma.deleteCollection({ name: process.env.CHROMA_COLLECTION }); } catch { /* fresh */ }
  const memory = await import(`../src/memory/chroma.js?test=${Date.now()}`);

  // Orthogonal one-hot vectors: every memory is equidistant from the query, so which ones come back
  // is decided purely by the metadata filter, not by similarity luck.
  const vector = (index: number) => Array.from({ length: 8 }, (_, k) => (k === index ? 1 : 0));
  await memory.saveMemoryVector({ id: "m-alice", text: "alice ชอบกาแฟ", userId: ALICE, timestamp: "2026-01-01T00:00:00.000Z" }, vector(0));
  await memory.saveMemoryVector({ id: "m-bob", text: "bob ไม่ชอบกาแฟ", userId: BOB, timestamp: "2026-01-02T00:00:00.000Z" }, vector(0));
  await memory.saveMemoryVector({ id: "m-room", text: "เรื่องในห้องรวม", userId: ALICE, timestamp: "2026-01-03T00:00:00.000Z", sessionKey: `group:${ROOM}` }, vector(0));
  await memory.saveMemoryVector({ id: "m-orphan", text: "ไม่มีเจ้าของ", timestamp: "2026-01-04T00:00:00.000Z" }, vector(0));

  const ids = (rows: { id: string }[]) => rows.map((row) => row.id).sort().join(",");
  // The bug this migration exists to prevent, shown from the other side: an untagged memory is
  // invisible to a scoped search, so backfilling is not cosmetic.
  check("an unscoped search still sees the whole collection", ids(await memory.searchMemoriesByVector(vector(0), 10)) === "m-alice,m-bob,m-orphan,m-room");
  check("scoped search misses untagged rows", ids(await memory.searchMemoriesByVector(vector(0), 10, keys.userSessionKey(ALICE))) === "");
  const migrated = await memory.migrateMemorySessions();
  check("backfill keyed the untagged rows", migrated.backfilled === 3);
  check("one had no author to derive a key from", migrated.unattributed === 1);
  check("the tagged one was left alone", migrated.alreadyKeyed === 1);
  const rerun = await memory.migrateMemorySessions();
  check("backfill is idempotent", rerun.backfilled === 0 && rerun.alreadyKeyed === 4);
  check("alice's private search finds only alice", ids(await memory.searchMemoriesByVector(vector(0), 10, keys.userSessionKey(ALICE))) === "m-alice");
  check("bob's finds only bob", ids(await memory.searchMemoriesByVector(vector(0), 10, keys.userSessionKey(BOB))) === "m-bob");
  check("the room is its own stream", ids(await memory.searchMemoriesByVector(vector(0), 10, keys.groupSessionKey(ROOM))) === "m-room");
  check("unattributable lands in the legacy bucket", ids(await memory.searchMemoriesByVector(vector(0), 10, keys.LEGACY_SESSION_KEY)) === "m-orphan");
  check("a session nobody is in recalls nothing", (await memory.searchMemoriesByVector(vector(0), 10, keys.userSessionKey("999999999999999999"))).length === 0);
  // userId + sessionKey must AND, not OR: chromadb rejects a two-key where map, so this is the
  // behaviour the `$and` wrapper buys.
  check("list by session only", ids(await memory.listMemories({ sessionKey: keys.userSessionKey(ALICE) })) === "m-alice");
  check("list by user only", ids(await memory.listMemories({ userId: ALICE })) === "m-alice,m-room");
  check("list by user AND session", ids(await memory.listMemories({ userId: ALICE, sessionKey: keys.userSessionKey(ALICE) })) === "m-alice");
  check("count honours the session", await memory.countMemories({ sessionKey: keys.groupSessionKey(ROOM) }) === 1);
  check("count without a filter is the whole collection", await memory.countMemories() === 4);
  check("delete by an empty session deletes nothing", await memory.deleteMemories({ sessionKey: keys.groupSessionKey("999999999999999999") }) === 0);
  check("and the collection survives that", await memory.countMemories() === 4);
  let refused = false;
  try { await memory.deleteMemories({}); } catch { refused = true; }
  check("an unfiltered delete is still refused", refused);
  check("delete by session really scopes", await memory.deleteMemories({ sessionKey: keys.groupSessionKey(ROOM) }) === 1);
  check("the private memories are untouched", await memory.countMemories() === 3);

  await chroma.deleteCollection({ name: process.env.CHROMA_COLLECTION });
  delete process.env.CHROMA_COLLECTION;
}

/* ------------------------------------------------------------------ *
 * 13. What a session-keyed batch means downstream
 *
 * The scheduler, the ladder owner and the rename map all act *after* routing has been
 * decided, and each is a place where a shared room could quietly credit the wrong
 * person. They are checked here rather than in test-profile.ts §K3 because §K3 asks
 * what the model is told; these ask what the code does with the batch it built.
 * ------------------------------------------------------------------ */
console.log("=== 13. batching, turn owner, renames in a shared stream ===");
{
  // Importing the pipeline runs the profile migration against SQLITE_PATH and pulls in the
  // Gemini key pools, so both are pinned before the import: the temp DB (already current) and
  // bogus keys, because a real key here would be silently spent by any accidental request.
  process.env.SQLITE_PATH = dbPath;
  process.env.CHROMA_COLLECTION = "aira_sessions_test_unused";
  process.env.GEMINI1_API_KEYS = "bogus-key-for-offline-test";
  process.env.GEMINI2_API_KEYS = "bogus-key-for-offline-test";
  const pipe = await import("../src/pipeline/pipeline.js");
  const { MessageScheduler } = await import("../src/pipeline/scheduler.js");
  type Row = Parameters<typeof pipe.restateHistory>[0][number];

  const mk = (userId: string, user: string, sessionKey: string, messageId: string): ScheduledMessage => ({
    userId, user, text: `t-${messageId}`, timestamp: "2026-01-01T00:00:00.000Z", channelId: ROOM, messageId, sessionKey,
  });
  // `userId`/`user`/`fileName` are optional strings on HistoryMessage (a NULL column reads back as
  // undefined), so the helper takes undefined rather than null — passing null here would model a
  // shape the driver never actually returns.
  const row = (id: number, role: "user" | "model", userId: string | undefined, user: string | undefined, text: string): Row =>
    ({ id, role, userId, user, text, timestamp: "2026-01-01T00:00:00.000Z", summary: null, sessionKey: `group:${ROOM}` });

  const flushed: ScheduledMessage[][] = [];
  const scheduler = new MessageScheduler({ debounceMs: 40, maxWaitMs: 500, onFlush: (batch) => { flushed.push(batch); } });
  // Alice, then Bob in the SAME room, then Alice again: one conversation, answered once.
  scheduler.push(mk(ALICE, "Alice", `group:${ROOM}`, "a1"));
  scheduler.push(mk(BOB, "Bob", `group:${ROOM}`, "b1"));
  scheduler.push(mk(ALICE, "Alice", `group:${ROOM}`, "a2"));
  // Carol never joined anything: her turn must not wait behind the room, nor merge into it.
  scheduler.push(mk("carol", "Carol", keys.userSessionKey("carol"), "c1"));
  check("two sessions pending, not three", scheduler.pendingCount() === 2);
  await new Promise((resolve) => setTimeout(resolve, 300));
  check("one flush per session", flushed.length === 2);
  const room = flushed.find((batch) => batch[0].sessionKey === `group:${ROOM}`);
  const solo = flushed.find((batch) => batch[0].sessionKey === keys.userSessionKey("carol"));
  check("the room merged all three messages", room?.map((m) => m.messageId).join(",") === "a1,b1,a2");
  check("and kept both speakers", new Set(room?.map((m) => m.userId)).size === 2);
  check("arrival order survives the queue", room?.map((m) => m.user).join(",") === "Alice,Bob,Alice");
  check("a private session stays its own batch", solo?.length === 1 && solo[0].messageId === "c1");
  check("no batch ever spans two sessions", flushed.every((batch) => batch.every((m) => m.sessionKey === batch[0].sessionKey)));

  // A second speaker must NOT cut off the turn that is about to answer the first one —
  // that is exactly why interruptByOtherUser became interruptOtherSessions.
  const interrupted: ScheduledMessage[][] = [];
  const s2 = new MessageScheduler({ debounceMs: 5_000, maxWaitMs: 5_000, onFlush: (batch) => { interrupted.push(batch); } });
  s2.push(mk(ALICE, "Alice", `group:${ROOM}`, "x1"));
  s2.interruptOtherSessions(`group:${ROOM}`);
  check("a message from the same room interrupts nothing", interrupted.length === 0 && s2.pendingCount() === 1);
  s2.push(mk("dave", "Dave", keys.userSessionKey("dave"), "y1"));
  s2.interruptOtherSessions(keys.userSessionKey("dave"));
  check("a message from another session flushes the room", interrupted.length === 1 && interrupted[0][0].messageId === "x1");
  check("and leaves its own queue running", s2.pendingCount() === 1);
  s2.flushAll();
  check("flushAll drains what is left", s2.pendingCount() === 0);

  // --- whose ladder this turn moves ---
  check("the owner is the LAST speaker",
    pipe.turnOwner([{ userId: ALICE, user: "Alice" }, { userId: BOB, user: "Bob" }, { userId: "carol", user: "Carol" }])?.userId === "carol");
  check("a private turn owns itself", pipe.turnOwner([{ userId: ALICE, user: "Alice" }])?.userId === ALICE);
  check("nobody spoke, nobody advances", pipe.turnOwner([]) === null);
  // She answers one person and rewards exactly that person, or the footer lies.
  check("the ladder owner is the reply anchor's author",
    room !== undefined && room[room.length - 1].userId === pipe.turnOwner(room.map((m) => ({ userId: m.userId, user: m.user })))?.userId);

  // --- renames inside a SHARED stream ---
  // restateHistory() used to take one (userId, name) pair. In a group window that is not enough:
  // renaming Alice must not rename Bob, and must not touch Isla's own replies.
  const shared = [
    row(1, "user", ALICE, "OldAlice", "OldAlice: สวัสดี\nบรรทัดสอง"),
    row(2, "model", undefined, undefined, "Isla: หวัดดีค่ะ"),
    row(3, "user", BOB, "Bob", "Bob: หวัดดี"),
    row(4, "user", ALICE, "OldAlice", "OldAlice: อีกแล้ว"),
  ];
  const restated = pipe.restateHistory(shared, new Map([[ALICE, "NewAlice"]]));
  check("Alice's user_name is restamped", restated[0].user === "NewAlice" && restated[3].user === "NewAlice");
  check("every line of hers is relabelled", restated[0].text === "NewAlice: สวัสดี\nบรรทัดสอง");
  check("Bob is left alone", restated[2].user === "Bob" && restated[2].text === "Bob: หวัดดี");
  check("Isla's reply is untouched", restated[1].text === "Isla: หวัดดีค่ะ" && restated[1].user === undefined);
  check("an empty rename map changes nobody", pipe.restateHistory(shared, new Map()).every((r, i) => r.user === shared[i].user));
  check("a name already current is a no-op",
    pipe.restateHistory([row(1, "user", ALICE, "NewAlice", "NewAlice: หวัดดี")], new Map([[ALICE, "NewAlice"]]))[0].text === "NewAlice: หวัดดี");
  // Speakers are matched by id, never by name: Bob may be *called* "Alice Jr." and renaming the
  // real Alice must not reach into his rows.
  const lookalike = pipe.restateHistory([row(1, "user", BOB, "Alice Jr.", "Alice Jr.: สวัสดี")], new Map([[ALICE, "NewAlice"]]));
  check("a lookalike name is not rewritten by someone else's rename", lookalike[0].text === "Alice Jr.: สวัสดี" && lookalike[0].user === "Alice Jr.");

  // --- the scoping has to be in the code, not merely available as helpers ---
  const pipelineSource = readFileSync(join(import.meta.dirname, "../src/pipeline/pipeline.ts"), "utf8");
  const scoped = pipelineSource
    .split("\n")
    .filter((line) => /getHistory\(|searchMemoriesByVector\(/.test(line) && !/^\s*(\/\/|\*|\/\*)/.test(line));
  check("the pipeline does read history and memories", scoped.length >= 2, `${scoped.length} call site(s)`);
  check("every one of them passes a session key", scoped.every((line) => line.includes("sessionKey")), scoped.join(" ⏎ "));
  check("history is read for THIS session only", pipelineSource.includes("getHistory(50, sessionKey)"));
  check("memories are recalled inside THIS session", pipelineSource.includes("searchMemoriesByVector(vector, 8, sessionKey)"));
  check("the user turn is written with its key", pipelineSource.includes("timestamp, fileName, sessionKey }"));
  check("her reply is written with the same key", pipelineSource.includes("timestamp: responseTimestamp, sessionKey }"));
  check("the ladder moves for the owner, not the first speaker", pipelineSource.includes("applyState(state, owner.userId"));
  check("a memory written here carries the session", pipelineSource.includes("text: state.ingestMemory, userId, timestamp, sessionKey }"));
}

rmSync(dir, { recursive: true, force: true });
console.log(fail ? `\n❌ ${fail} FAILED — ${pass} passed` : `\n✅ ALL PASS — ${pass} passed, 0 failed`);
process.exit(fail ? 1 : 0);
