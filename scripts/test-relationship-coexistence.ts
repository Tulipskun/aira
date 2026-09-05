import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "aira-relationship-coexistence-"));
process.env.SQLITE_PATH = join(dir, "test.db");

try {
  const { getUserProfile, migrateUserProfiles } = await import("../src/sql/profile.js");
  const { applyTurnStateAtomic } = await import("../src/sql/turn-transaction.js");
  migrateUserProfiles();

  const alice = applyTurnStateAtomic(
    {
      userId: "alice",
      userName: "Alice",
      affinity: 900,
      isFlirt: true,
      approvals: { lover: true, soulmate: false, sibling: false, family: false },
    },
    [],
    [],
    "2026-09-05T10:00:00.000Z",
    "discord:channel:global",
  );
  assert.equal(alice.bond, "lover");

  const bob = applyTurnStateAtomic(
    {
      userId: "bob",
      userName: "Bob",
      affinity: 900,
      isFlirt: true,
      approvals: { lover: true, soulmate: false, sibling: false, family: false },
    },
    [],
    [],
    "2026-09-05T10:01:00.000Z",
    "discord:channel:global",
  );
  assert.equal(bob.bond, "lover");

  assert.equal(getUserProfile("alice")?.bond, "lover");
  assert.equal(getUserProfile("bob")?.bond, "lover");

  const prompt = await readFile(join(import.meta.dirname, "../src/gemini/prompts/isla.md"), "utf8");
  assert.match(prompt, /non-exclusive|ไม่ผูกขาด|หลายคน.*lover|lover.*หลายคน/i);
  assert.match(prompt, /อีกคน.*lover|another.*lover|relationship.*another person/i);

  console.log("relationship coexistence tests: OK");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
