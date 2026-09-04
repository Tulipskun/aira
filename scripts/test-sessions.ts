import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MessageFlags } from "discord.js";

const dir = mkdtempSync(join(tmpdir(), "aira-sessions-test-"));
process.env.SQLITE_PATH = join(dir, "test.db");
process.env.DISCORD_CONFIG_PATH = join(dir, "discord-config.json");
writeFileSync(process.env.DISCORD_CONFIG_PATH, JSON.stringify({ responseChannelId: "200" }));

const sessions = await import("../src/sql/sessions.js");
const profile = await import("../src/sql/profile.js");
const { handleIslaCommand, ISLA_COMMAND_NAME, ISLA_SUBCOMMANDS, islaCommandPayload } = await import("../src/bot/interactions.js");

const ALICE = "100";
const BOB = "200";
const ROOM = "200";

assert.equal(sessions.sessionKeyFor(ALICE, ROOM), `user:${ALICE}`);
assert.equal(sessions.groupMembership(ALICE), null);

const joined = sessions.joinGroup(ALICE, ROOM);
assert.equal(joined.status, "joined");
assert.equal(sessions.sessionKeyFor(ALICE, ROOM), `group:${ROOM}`);
assert.equal(sessions.groupMembership(ALICE)?.channelId, ROOM);

const again = sessions.joinGroup(ALICE, ROOM);
assert.equal(again.status, "already");
assert.equal(again.current.joinedAt, joined.current.joinedAt);

const moved = sessions.joinGroup(ALICE, "201");
assert.equal(moved.status, "moved");
assert.equal(moved.previousChannel, ROOM);
assert.equal(sessions.sessionKeyFor(ALICE, ROOM), `user:${ALICE}`);
assert.equal(sessions.sessionKeyFor(ALICE, "201"), `group:201`);

assert.equal(sessions.leaveGroup(ALICE)?.channelId, "201");
assert.equal(sessions.groupMembership(ALICE), null);
assert.equal(sessions.leaveGroup(ALICE), null);

function fakeInteraction(sub: string, userId = ALICE, channelId: string | null = ROOM) {
  const sent: any[] = [];
  return {
    interaction: {
      channelId,
      user: { id: userId },
      options: { getSubcommand: () => sub },
      reply: async (payload: any) => { sent.push(payload); },
    } as any,
    sent,
  };
}

// join-group / leave-group / status remain private acknowledgements.
{
  const { interaction, sent } = fakeInteraction(ISLA_SUBCOMMANDS.joinGroup);
  await handleIslaCommand(interaction);
  assert.equal(sent[0].flags, MessageFlags.Ephemeral);
  assert.equal(sessions.groupMembership(ALICE)?.channelId, ROOM);
}
{
  const { interaction, sent } = fakeInteraction(ISLA_SUBCOMMANDS.status);
  await handleIslaCommand(interaction);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].flags, MessageFlags.Ephemeral);
  assert.match(sent[0].content, /group:200/);
}
{
  const { interaction, sent } = fakeInteraction(ISLA_SUBCOMMANDS.leaveGroup);
  await handleIslaCommand(interaction);
  assert.equal(sent[0].flags, MessageFlags.Ephemeral);
  assert.equal(sessions.groupMembership(ALICE), null);
}

// Leaderboard uses the existing merged profile table and is deliberately public.
profile.upsertUserProfile({ userId: ALICE, userName: "farris", xp: 2540, flirtCount: 30, bond: "lover" });
profile.upsertUserProfile({ userId: BOB, userName: "yuuta", xp: 1200, flirtCount: 8, bond: "friend" });
profile.upsertUserProfile({ userId: "300", userName: "third", xp: 900, flirtCount: 4, bond: "close_friend" });

{
  const { interaction, sent } = fakeInteraction(ISLA_SUBCOMMANDS.leaderboard);
  await handleIslaCommand(interaction);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].flags, undefined);
  assert.equal(sent[0].embeds.length, 1);
  const description = sent[0].embeds[0].data.description;
  assert.match(description, /1\. \*\*farris\*\* \(คนรัก\) ❤️ 2540 \[Flirt: 30\]/);
  assert.match(description, /2\. \*\*yuuta\*\* \(เพื่อน\) .*1200 \[Flirt: 8\]/);
  assert.match(description, /3\. \*\*third\*\* \(เพื่อนสนิท\)/);
}

// Payload must contain exactly the supported public slash subcommands. `/isla say` is retired.
const payload = islaCommandPayload();
assert.equal(payload.name, ISLA_COMMAND_NAME);
assert.deepEqual(payload.options.map((option) => option.name), [
  "join-group",
  "leave-group",
  "status",
  "leaderboard",
]);
assert.equal(Object.values(ISLA_SUBCOMMANDS).length, 4);
assert.ok(!payload.options.some((option) => option.name === "say"));
assert.ok(payload.options.every((option) => option.type === 1));
assert.ok(payload.options.every((option) => typeof option.description === "string" && /[ก-๙]/.test(option.description)));

// Registration is an explicit CLI operation, not part of bot startup.
const cli = await import("./aira-cli.js");
assert.deepEqual(cli.buildCommand(["register_commands"]), { command: "register_commands" });
const botSource = await Bun.file(join(import.meta.dirname, "../src/bot/bot.ts")).text();
assert.ok(!botSource.includes("register-commands"));

rmSync(dir, { recursive: true, force: true });
console.log("session/interaction tests: OK");
