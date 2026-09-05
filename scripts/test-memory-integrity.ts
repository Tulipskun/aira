import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "aira-memory-integrity-"));
process.env.SQLITE_PATH = join(dir, "test.db");

try {
  const { getUserProfile, migrateUserProfiles } = await import("../src/sql/profile.js");
  const { applyTurnStateAtomic } = await import("../src/sql/turn-transaction.js");
  const { ISLA_STATE_SCHEMA, parseIslaState } = await import("../src/gemini/state-format.js");
  migrateUserProfiles();

  const base = "2026-09-05T01:00:00.000Z";
  const state = { lover: false, soulmate: false, sibling: false, family: false };

  const factRequired = (ISLA_STATE_SCHEMA.properties.add_facts.items as unknown as { required?: readonly string[] }).required;
  assert.deepEqual(factRequired, ["text", "owner_user_id", "confirmed_by_owner"]);
  const parsedProposal = parseIslaState(JSON.stringify({ affinity: 10, select_image: "none", add_facts: [{ text: "ชอบชา", owner_user_id: "alice", confirmed_by_owner: true }] }), "stranger");
  assert.deepEqual(parsedProposal.factProposals?.[0], { text: "ชอบชา", ownerUserId: "alice", confirmedByOwner: true });
  const invalidProposal = parseIslaState(JSON.stringify({ affinity: 10, select_image: "none", add_facts: [{ text: "ชอบชา", confirmed_by_owner: true }] }), "stranger");
  assert.equal(invalidProposal.factProposals?.length ?? 0, 0);

  const prompt = readFileSync(join(import.meta.dirname, "../src/gemini/prompts/isla.md"), "utf8");
  assert(prompt.includes("authoritative"));
  assert(prompt.includes("confirmed"));
  assert(prompt.includes("conflicting"));
  assert(!prompt.includes("turn_state_applied"));
  assert(!prompt.includes("ChromaDB"));
  assert(prompt.includes("<current_time>"));

  applyTurnStateAtomic({ userId: "alice", userName: "Alice", affinity: 0, approvals: state }, [{ text: "ชอบกินผัก", ownerUserId: "alice", confirmedByOwner: true }], [], base, "group:example");

  const conflict = applyTurnStateAtomic({ userId: "alice", userName: "Alice", affinity: 0, approvals: state }, [{ text: "ไม่ชอบกินผัก", ownerUserId: "alice", confirmedByOwner: false, replacesFact: "ชอบกินผัก" }], [], "2026-09-05T02:00:00.000Z", "group:example");
  assert.equal(conflict.factsAdded, 0);
  assert.deepEqual(getUserProfile("alice")?.facts.map((fact) => fact.text), ["ชอบกินผัก"]);

  const replacement = applyTurnStateAtomic({ userId: "alice", userName: "Alice", affinity: 0, approvals: state }, [{ text: "ไม่ชอบกินผักแล้ว", ownerUserId: "alice", confirmedByOwner: true, replacesFact: "ชอบกินผัก" }], [], "2026-09-05T03:00:00.000Z", "group:example");
  assert.equal(replacement.factsAdded, 1);
  assert.deepEqual(getUserProfile("alice")?.facts.map((fact) => [fact.text, fact.status]), [["ไม่ชอบกินผักแล้ว", "confirmed"], ["ชอบกินผัก", "historical"]]);

  applyTurnStateAtomic({ userId: "bob", userName: "Bob", affinity: 0, approvals: state }, [{ text: "ชอบกินผัก", ownerUserId: "bob", confirmedByOwner: true }], [], "2026-09-05T04:00:00.000Z", "group:example");
  const thirdParty = applyTurnStateAtomic({ userId: "alice", userName: "Alice", affinity: 0, approvals: state }, [{ text: "Bob ไม่ชอบกินผัก", ownerUserId: "bob", confirmedByOwner: false }], [], "2026-09-05T05:00:00.000Z", "group:example");
  assert.equal(thirdParty.factsAdded, 0);
  assert.deepEqual(getUserProfile("bob")?.facts.map((fact) => fact.text), ["ชอบกินผัก"]);
  assert.ok(!getUserProfile("alice")?.facts.some((fact) => fact.text.includes("Bob")));

  console.log("test-memory-integrity: PASS");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
