import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "aira-memory-integrity-"));
process.env.SQLITE_PATH = join(dir, "test.db");

try {
  const { getUserProfile, migrateUserProfiles } = await import("../src/sql/profile.js");
  const { applyTurnStateAtomic } = await import("../src/sql/turn-transaction.js");
  migrateUserProfiles();

  const base = "2026-09-05T01:00:00.000Z";
  const later = "2026-09-05T02:00:00.000Z";
  const state = { lover: false, soulmate: false, sibling: false, family: false };

  applyTurnStateAtomic(
    { userId: "alice", userName: "Alice", affinity: 0, approvals: state },
    [{ text: "ชอบกินผัก", ownerUserId: "alice", confirmedByOwner: true }],
    [], base, "group:example",
  );

  const conflict = applyTurnStateAtomic(
    { userId: "alice", userName: "Alice", affinity: 0, approvals: state },
    [{ text: "ไม่ชอบกินผัก", ownerUserId: "alice", confirmedByOwner: false }],
    [], later, "group:example",
  );
  assert.equal(conflict.factsAdded, 0);
  assert.deepEqual(getUserProfile("alice")?.facts.map((fact) => fact.text), ["ชอบกินผัก"]);

  const replacement = applyTurnStateAtomic(
    { userId: "alice", userName: "Alice", affinity: 0, approvals: state },
    [{ text: "ไม่ชอบกินผักแล้ว", ownerUserId: "alice", confirmedByOwner: true }],
    [], "2026-09-05T03:00:00.000Z", "group:example",
  );
  assert.equal(replacement.factsAdded, 1);
  assert.deepEqual(getUserProfile("alice")?.facts.map((fact) => [fact.text, fact.status]), [
    ["ไม่ชอบกินผักแล้ว", "confirmed"],
    ["ชอบกินผัก", "historical"],
  ]);

  applyTurnStateAtomic(
    { userId: "bob", userName: "Bob", affinity: 0, approvals: state },
    [{ text: "ชอบกินผัก", ownerUserId: "bob", confirmedByOwner: true }],
    [], "2026-09-05T04:00:00.000Z", "group:example",
  );

  const thirdParty = applyTurnStateAtomic(
    { userId: "alice", userName: "Alice", affinity: 0, approvals: state },
    [{ text: "Bob ไม่ชอบกินผัก", ownerUserId: "bob", confirmedByOwner: false }],
    [], "2026-09-05T05:00:00.000Z", "group:example",
  );
  assert.equal(thirdParty.factsAdded, 0);
  assert.deepEqual(getUserProfile("bob")?.facts.map((fact) => fact.text), ["ชอบกินผัก"]);
  assert.ok(!getUserProfile("alice")?.facts.some((fact) => fact.text.includes("Bob")));

  console.log("test-memory-integrity: PASS");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
