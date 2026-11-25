import { strict as assert } from "node:assert";
import { writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadCharacters, findMentionedCharacters, characterSessionKey, loadCharacterPrompt, resolveCharacterSelection } from "../src/characters/registry.js";

const root = join(import.meta.dirname, "..");
const fixtureDefinition = join(root, "characters", "test-fixture.json");
const fixturePrompt = join(root, "characters", "test-fixture.md");

try {
  const initial = loadCharacters();
  assert.equal(initial.length, 1, "Isla is the only built-in character");
  const isla = initial[0]!;
  assert.equal(isla.id, "isla");
  assert.match(loadCharacterPrompt(isla), /Isla/);
  assert.deepEqual(findMentionedCharacters("วันนี้อยากคุยกับไอล่าหน่อย", initial).map((item) => item.id), ["isla"]);
  assert.deepEqual(findMentionedCharacters("@Isla are you there?", initial).map((item) => item.id), ["isla"]);
  assert.equal(characterSessionKey("channel:123", "isla"), "channel:123");
  assert.equal(characterSessionKey("channel:123", "luna"), "channel:123:character:luna");

  writeFileSync(fixturePrompt, "A temporary test character.");
  writeFileSync(fixtureDefinition, JSON.stringify({
    id: "test-npc",
    name: "TestNPC",
    aliases: ["ตัวทดสอบ"],
    promptFile: "test-fixture.md",
    enabled: true,
  }));
  const withFixture = loadCharacters();
  assert.equal(withFixture.length, 2);
  const mentioned = findMentionedCharacters("ขอคุยกับตัวทดสอบหน่อย", withFixture);
  assert.deepEqual(mentioned.map((item) => item.id), ["test-npc"]);
  assert.deepEqual(resolveCharacterSelection(withFixture, mentioned, []).map((item) => item.id), ["isla", "test-npc"]);
  assert.deepEqual(resolveCharacterSelection(withFixture, [], ["test-npc", "unknown"]).map((item) => item.id), ["isla", "test-npc"]);
  assert.equal(characterSessionKey("channel:123", "test-npc"), "channel:123:character:test-npc");
  assert.match(loadCharacterPrompt(withFixture.find((item) => item.id === "test-npc")!), /temporary test character/);
  console.log("Character registry: all assertions passed.");
} finally {
  rmSync(fixtureDefinition, { force: true });
  rmSync(fixturePrompt, { force: true });
}
const temporaryDirectory = mkdtempSync(join(tmpdir(), "aira-character-relationships-"));
const previousSqlitePath = process.env.SQLITE_PATH;
process.env.SQLITE_PATH = join(temporaryDirectory, "test.db");
try {
  const relationships = await import("../src/sql/character-relationships.js");
  assert.equal(relationships.getCharacterRelationship("luna", "user-1"), "ยังไม่เคยสร้างความสัมพันธ์");
  relationships.saveCharacterRelationship("luna", "user-1", "เริ่มสนิทกัน");
  relationships.saveCharacterRelationship("mika", "user-1", "เพิ่งรู้จักกัน");
  relationships.saveCharacterRelationship("luna", "user-2", "เป็นเพื่อนกัน");
  assert.equal(relationships.getCharacterRelationship("luna", "user-1"), "เริ่มสนิทกัน");
  assert.equal(relationships.getCharacterRelationship("mika", "user-1"), "เพิ่งรู้จักกัน");
  assert.equal(relationships.getCharacterRelationship("luna", "user-2"), "เป็นเพื่อนกัน");
  relationships.closeCharacterRelationshipsDb();
  console.log("Character relationship isolation: all assertions passed.");
} finally {
  if (previousSqlitePath === undefined) delete process.env.SQLITE_PATH;
  else process.env.SQLITE_PATH = previousSqlitePath;
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
