import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "aira-turn-"));
process.env.SQLITE_PATH = join(dir, "test.db");

try {
  const { getUserProfile, migrateUserProfiles } = await import("../src/sql/profile.js");
  const { applyTurnStateAtomic } = await import("../src/sql/turn-transaction.js");
  migrateUserProfiles();

  const first = applyTurnStateAtomic(
    {
      userId: "u1",
      userName: "Yuuta",
      affinity: 25,
      isFlirt: true,
      approvals: { lover: false, soulmate: false, sibling: false, family: false },
    },
    ["ชอบกาแฟ", "ชอบกาแฟ"],
    ["ยูตะ"],
    "2026-09-04T15:00:00.000Z",
    "discord:channel:test",
  );

  assert.equal(first.duplicate, false);
  assert.equal(first.xp, 50);
  assert.equal(first.flirtCount, 1);
  assert.equal(first.flirtDelta, 1);
  assert.equal(first.factsAdded, 1);
  assert.equal(first.nicknamesAdded, 1);

  const stored = getUserProfile("u1");
  assert.equal(stored?.xp, 50);
  assert.equal(stored?.flirtCount, 1);
  assert.deepEqual(stored?.nickname, ["ยูตะ"]);
  assert.equal(stored?.facts.length, 1);

  const duplicate = applyTurnStateAtomic(
    {
      userId: "u1",
      userName: "Yuuta",
      affinity: 25,
      isFlirt: true,
      approvals: { lover: false, soulmate: false, sibling: false, family: false },
    },
    ["fact ซ้ำ"],
    ["ชื่อใหม่"],
    "2026-09-04T15:00:00.000Z",
    "discord:channel:test",
  );

  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.flirtDelta, 0);
  assert.equal(duplicate.bondUnlocked, false);
  assert.equal(getUserProfile("u1")?.xp, 50);
  assert.equal(getUserProfile("u1")?.flirtCount, 1);
  assert.deepEqual(getUserProfile("u1")?.nickname, ["ยูตะ"]);

  console.log("turn-transaction tests: OK");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
