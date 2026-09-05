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

  function makeLover(userId: string, userName: string, baseMinute: number) {
    const sessionKey = "discord:channel:global";
    applyTurnStateAtomic(
      { userId, userName, affinity: 300, isFlirt: false, approvals: { lover: false, soulmate: false, sibling: false, family: false } },
      [], [], `2026-09-05T10:${String(baseMinute).padStart(2, "0")}:00.000Z`, sessionKey,
    );
    for (let i = 1; i <= 5; i++) {
      applyTurnStateAtomic(
        { userId, userName, affinity: 0, isFlirt: true, approvals: { lover: false, soulmate: false, sibling: false, family: false } },
        [], [], `2026-09-05T10:${String(baseMinute + i).padStart(2, "0")}:00.000Z`, sessionKey,
      );
    }
    return applyTurnStateAtomic(
      { userId, userName, affinity: 0, isFlirt: false, approvals: { lover: true, soulmate: false, sibling: false, family: false } },
      [], [], `2026-09-05T10:${String(baseMinute + 6).padStart(2, "0")}:00.000Z`, sessionKey,
    );
  }

  const alice = makeLover("alice", "Alice", 0);
  assert.equal(getUserProfile("alice")?.bond, "lover");
  assert.equal(alice.bondUnlocked, true);

  const bob = makeLover("bob", "Bob", 10);
  assert.equal(getUserProfile("bob")?.bond, "lover");
  assert.equal(bob.bondUnlocked, true);

  assert.equal(getUserProfile("alice")?.bond, "lover");
  assert.equal(getUserProfile("bob")?.bond, "lover");

  const prompt = await readFile(join(import.meta.dirname, "../src/gemini/prompts/isla.md"), "utf8");
  assert.match(prompt, /non-exclusive|ไม่ผูกขาด|หลายคน.*lover|lover.*หลายคน/i);
  assert.match(prompt, /อีกคน.*lover|another.*lover|relationship.*another person/i);

  const statePrompt = await readFile(join(import.meta.dirname, "../src/gemini/prompts/isla-state.md"), "utf8");
  assert.match(statePrompt, /ไม่ผูกขาด|non-exclusive/i);
  assert.match(statePrompt, /ผู้ใช้อื่น.*ข้อจำกัด|another.*relationship.*constraint/i);

  console.log("relationship coexistence tests: OK");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
