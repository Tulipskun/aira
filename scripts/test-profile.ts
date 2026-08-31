// Tests for the merged user_profiles table: `relationships` no longer exists, and one row now
// carries identity (name, nicknames, facts) and relationship state (bond, xp, trust, affection,
// familiarity) together.
//   bun run scripts/test-profile.ts
// No network: every case uses a throwaway SQLite file, and the execute cases avoid
// ingest_memory — the only operation that would reach Chroma/Gemini.

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let pass = 0;
let fail = 0;
function check(label: string, cond: boolean, seen?: unknown): void {
  console.log(`  ${cond ? "✅" : "❌"} ${label}${cond || seen === undefined ? "" : ` -- got: ${JSON.stringify(seen)}`}`);
  cond ? pass++ : fail++;
}

const dir = mkdtempSync(join(tmpdir(), "aira-profile-test-"));
const { Database } = await import("bun:sqlite");

/** Import a fresh copy of the module so it opens `file` with its own migration pass. */
async function loadProfile(file: string, tag: string) {
  process.env.SQLITE_PATH = file;
  return import(`../src/sql/profile.js?${tag}=${Date.now()}`);
}

function tableNames(db: InstanceType<typeof Database>): string[] {
  return (db.query(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[])
    .map((r) => r.name);
}
function columnNames(db: InstanceType<typeof Database>, table: string): string[] {
  return (db.query(`SELECT name FROM pragma_table_info(?)`).all(table) as { name: string }[]).map((r) => r.name);
}

// ---------------------------------------------------------------- A. bond ladder rules
console.log("=== A. bond ladder rules (src/sql/bonds.ts) ===");
const bonds = await import("../src/sql/bonds.js");
check("stranger -> friend allowed", bonds.resolveBondChange("stranger", "friend") === "friend");
check("unknown rung refused", bonds.resolveBondChange("stranger", "bestie") === null);
check("null target refused", bonds.resolveBondChange("stranger", null) === null);
check("sibling cannot become lover", bonds.resolveBondChange("sibling", "lover") === null);
check("sibling cannot become soulmate", bonds.resolveBondChange("sibling", "soulmate") === null);
check("sibling may stay crush-level", bonds.resolveBondChange("sibling", "crush") === "crush");
check("family may become sibling", bonds.resolveBondChange("family", "sibling") === "sibling");
check("friend may become enemy", bonds.resolveBondChange("friend", "enemy") === "enemy");
// The rule that used to live only in the prompt text.
check("leaving enemy jumps to friend, not stranger", bonds.resolveBondChange("enemy", "stranger") === "friend");
check("leaving enemy to crush keeps crush", bonds.resolveBondChange("enemy", "crush") === "crush");
check("enemy -> enemy is a no-op", bonds.resolveBondChange("enemy", "enemy") === "enemy");
check("unknown current bond is treated as stranger", bonds.resolveBondChange("nonsense", "friend") === "friend");
check("a stranger may be offered soulmate", bonds.resolveBondChange("stranger", "soulmate") === "soulmate");
check("ladder text lists every rung", bonds.BOND_NAMES.every((n) => bonds.bondLadderText().includes(n)));
check("ladder text states the enemy jump", bonds.bondLadderText().includes("ศัตรู") && bonds.bondLadderText().includes("friend"));

// ---------------------------------------------------------------- B. migration
console.log("=== B. migration from the old two-table layout ===");
const legacyFile = join(dir, "legacy.db");
{
  const raw = new Database(legacyFile);
  raw.run(`CREATE TABLE user_profiles (
    user_id TEXT PRIMARY KEY, name TEXT, nicknames_json TEXT, facts_json TEXT
  )`);
  raw.run(`INSERT INTO user_profiles (user_id, name, nicknames_json, facts_json) VALUES
    ('u1', 'Yuuta', '["จิ้มจุ้ม","น้อง"]', '["ชอบชา","อ่านหนังสือ"]'),
    ('u2', 'Farris', '[]', '[]')`);
  raw.run(`CREATE TABLE relationships (
    user_id TEXT PRIMARY KEY, user_name TEXT, state TEXT, xp INTEGER, affinity REAL
  )`);
  raw.run(`INSERT INTO relationships (user_id, user_name, state, xp, affinity) VALUES
    ('u1', 'Yuuta', 'close_friend', 120, 42.5),
    ('u2', 'Farris', 'friend', 10, 3.0),
    -- a user with relationship state but no profile row at all
    ('u3', 'Shadow', 'stranger', 0, 0)`);
  raw.close();
}
const mig = await loadProfile(legacyFile, "legacy");
{
  const raw = new Database(legacyFile);
  check("relationships table is gone", !tableNames(raw).includes("relationships"), tableNames(raw));
  const cols = columnNames(raw, "user_profiles");
  check("merged columns present", ["bond", "xp", "trust", "affection", "familiarity", "facts_json", "nickname_json", "user_name"].every((c) => cols.includes(c)), cols);
  check("legacy name column dropped", !cols.includes("name"), cols);
  check("legacy nicknames_json dropped", !cols.includes("nicknames_json"), cols);
  raw.close();

  const u1 = mig.getUserProfile("u1");
  check("u1 name carried over", u1?.userName === "Yuuta", u1?.userName);
  check("u1 nicknames carried over", JSON.stringify(u1?.nickname) === JSON.stringify(["จิ้มจุ้ม", "น้อง"]), u1?.nickname);
  check("u1 state -> bond", u1?.bond === "close_friend", u1?.bond);
  check("u1 xp carried over", u1?.xp === 120, u1?.xp);
  check("u1 affinity -> affection", u1?.affection === 42.5, u1?.affection);
  check("u1 trust defaults to 0", u1?.trust === 0, u1?.trust);
  check("u1 flat facts became {text,timestamp}", u1?.facts.length === 2 && u1.facts[0].text === "ชอบชา" && u1.facts[0].timestamp === "", u1?.facts);

  const u3 = mig.getUserProfile("u3");
  check("relationship-only user got a profile row", u3?.userName === "Shadow", u3?.userName);
  check("relationship-only user keeps stranger defaults", u3?.bond === "stranger" && u3?.xp === 0 && u3?.affection === 0);
  check("getUserProfiles reads all three", mig.getUserProfiles(["u1", "u2", "u3", ""]).length === 3);
  check("unknown user is null, not a crash", mig.getUserProfile("nobody") === null);
}

console.log("=== C. migration is idempotent ===");
{
  const again = mig.migrateUserProfiles();
  check("second run creates nothing", again.created === false, again);
  check("second run merges nothing", again.mergedRelationships === 0, again.mergedRelationships);
  const u1 = mig.getUserProfile("u1");
  check("data survives the second run", u1?.bond === "close_friend" && u1?.xp === 120 && u1?.nickname.length === 2, u1);
  const raw = new Database(legacyFile);
  check("row count unchanged", (raw.query(`SELECT COUNT(*) c FROM user_profiles`).get() as { c: number }).c === 3);
  raw.close();
}

console.log("=== D. AIRA_KEEP_LEGACY_SCHEMA: additive only ===");
const liveFile = join(dir, "live.db");
{
  const raw = new Database(liveFile);
  raw.run(`CREATE TABLE user_profiles (user_id TEXT PRIMARY KEY, name TEXT, nicknames_json TEXT, facts_json TEXT)`);
  raw.run(`INSERT INTO user_profiles VALUES ('u1','Yuuta','["จิ้มจุ้ม"]','["ชอบชา"]')`);
  raw.run(`CREATE TABLE relationships (user_id TEXT PRIMARY KEY, user_name TEXT, state TEXT, xp INTEGER, affinity REAL)`);
  raw.run(`INSERT INTO relationships VALUES ('u1','Yuuta','crush',7,9.5)`);
  raw.close();
  // A bot process is still running with the old statements compiled: it reads user_profiles.name
  // and writes relationships, so neither may disappear from under it.
  process.env.AIRA_KEEP_LEGACY_SCHEMA = "1";
}
const live = await loadProfile(liveFile, "live");
{
  const raw = new Database(liveFile);
  check("relationships kept while a live process uses it", tableNames(raw).includes("relationships"), tableNames(raw));
  const cols = columnNames(raw, "user_profiles");
  check("legacy columns kept too", cols.includes("name") && cols.includes("nicknames_json"), cols);
  raw.close();
  const u1 = live.getUserProfile("u1");
  check("but the merged data is readable", u1?.bond === "crush" && u1?.xp === 7 && u1?.affection === 9.5, u1);
  check("and identity data is readable", u1?.userName === "Yuuta" && u1?.nickname[0] === "จิ้มจุ้ม", u1?.nickname);
  check("migration reports it did not drop", live.migrateUserProfiles().droppedRelationships === false);
  delete process.env.AIRA_KEEP_LEGACY_SCHEMA;
}

console.log("=== E. finishing the migration after the restart ===");
{
  const done = await loadProfile(liveFile, "finish");
  const result = done.migrateUserProfiles();
  check("now it drops the table", result.droppedRelationships === true, result);
  const raw = new Database(liveFile);
  check("relationships gone", !tableNames(raw).includes("relationships"), tableNames(raw));
  const cols = columnNames(raw, "user_profiles");
  check("legacy columns gone", !cols.includes("name") && !cols.includes("nicknames_json"), cols);
  raw.close();
  const u1 = done.getUserProfile("u1");
  check("data intact after the second pass", u1?.bond === "crush" && u1?.xp === 7 && u1?.userName === "Yuuta", u1);
}

console.log("=== F. a brand-new database needs no migration work ===");
{
  const fresh = await loadProfile(join(dir, "fresh.db"), "fresh");
  const r = fresh.migrateUserProfiles();
  check("second pass reports nothing created", r.created === false, r);
  check("nothing to merge", r.mergedRelationships === 0, r);
  check("no legacy table left", r.droppedRelationships === true, r);
  check("writes work on a new table", fresh.upsertUserProfile({ userId: "n1", userName: "New" })?.userName === "New");
  const raw = new Database(join(dir, "fresh.db"));
  check("new table has exactly the merged columns", columnNames(raw, "user_profiles").join(",") === "user_id,user_name,nickname_json,bond,xp,trust,affection,familiarity,facts_json", columnNames(raw, "user_profiles"));
  raw.close();
}

console.log("=== G. half-migrated database (restarted mid-development) ===");
{
  const half = join(dir, "half.db");
  const raw = new Database(half);
  // Some new columns exist, some do not, and relationships is still around.
  raw.run(`CREATE TABLE user_profiles (user_id TEXT PRIMARY KEY, name TEXT, nicknames_json TEXT, facts_json TEXT, user_name TEXT, bond TEXT)`);
  raw.run(`INSERT INTO user_profiles (user_id, name, nicknames_json, facts_json, user_name, bond) VALUES ('u1','Yuuta','["จิ้ม"]','["ชอบชา"]','','close_friend')`);
  raw.run(`CREATE TABLE relationships (user_id TEXT PRIMARY KEY, user_name TEXT, state TEXT, xp INTEGER, affinity REAL)`);
  raw.run(`INSERT INTO relationships VALUES ('u1','Yuuta','close_friend',50,20)`);
  raw.close();
  const mod = await loadProfile(half, "half");
  const u1 = mod.getUserProfile("u1");
  check("missing columns added", u1?.xp === 50 && u1?.affection === 20, u1);
  check("existing bond not overwritten", u1?.bond === "close_friend", u1?.bond);
  check("name backfilled from the legacy column", u1?.userName === "Yuuta", u1?.userName);
  check("second pass is a no-op", mod.migrateUserProfiles().mergedRelationships === 0);
}

console.log("=== H. junk in a row degrades instead of throwing ===");
{
  const junk = join(dir, "junk.db");
  {
    const raw = new Database(junk);
    raw.run(`CREATE TABLE user_profiles (user_id TEXT PRIMARY KEY, name TEXT, nicknames_json TEXT, facts_json TEXT)`);
    raw.close();
  }
  const mod = await loadProfile(junk, "junk");
  mod.upsertUserProfile({
    userId: "j1",
    userName: "Junk",
    nickname: ["ok", "  ", 42 as unknown as string],
    bond: "not_a_rung" as never,
    facts: ["plain", { text: "obj", timestamp: "2026-01-01T00:00:00Z" }, { nope: 1 }, "", 7] as never,
  });
  const row = mod.getUserProfile("j1");
  check("bad bond falls back to stranger", row?.bond === "stranger", row?.bond);
  check("nicknames keep only non-empty strings", JSON.stringify(row?.nickname) === JSON.stringify(["ok"]), row?.nickname);
  check("facts keep both shapes and drop junk", row?.facts.length === 2 && row.facts[0].text === "plain" && row.facts[1].text === "obj", row?.facts);
  check("a fact without a timestamp reads as empty string", row?.facts[0].timestamp === "", row?.facts[0]);

  // Unparseable JSON straight from an old row.
  const raw2 = new Database(junk);
  raw2.run(`UPDATE user_profiles SET nickname_json = '{not json', facts_json = '[{"text":""},"  "]' WHERE user_id = 'j1'`);
  raw2.close();
  const reread = mod.getUserProfile("j1");
  check("broken nickname_json becomes []", reread?.nickname.length === 0, reread?.nickname);
  check("facts with no text are dropped", reread?.facts.length === 0, reread?.facts);
}

// ---------------------------------------------------------------- I. write API
console.log("=== I. partial patches never clobber the rest of the row ===");
{
  const mod = await loadProfile(join(dir, "api.db"), "api");
  mod.upsertUserProfile({ userId: "a1", userName: "Yuuta", nickname: ["จิ้มจุ้ม"], bond: "friend", facts: ["ชอบชา"] });
  mod.adjustProfileStats("a1", { xp: 10 });
  const after = mod.getUserProfile("a1");
  check("xp written", after?.xp === 10, after?.xp);
  check("identity untouched by a stat write", after?.userName === "Yuuta" && after?.nickname[0] === "จิ้มจุ้ม" && after?.facts[0].text === "ชอบชา", after);
  check("bond untouched by a stat write", after?.bond === "friend", after?.bond);

  mod.adjustProfileStats("a1", { affection: 95 });
  mod.adjustProfileStats("a1", { affection: 95 });
  check("affection clamped at 100", mod.getUserProfile("a1")?.affection === 100, mod.getUserProfile("a1")?.affection);
  mod.adjustProfileStats("a1", { affection: -500 });
  check("affection clamped at 0", mod.getUserProfile("a1")?.affection === 0);
  mod.adjustProfileStats("a1", { xp: -9999 });
  check("xp is open-ended downward", mod.getUserProfile("a1")?.xp === -9989, mod.getUserProfile("a1")?.xp);
  mod.adjustProfileStats("a1", { xp: Number.NaN, trust: undefined });
  check("NaN delta is ignored", mod.getUserProfile("a1")?.xp === -9989, mod.getUserProfile("a1")?.xp);
  check("adjustProfileStats creates a missing row", mod.adjustProfileStats("ghost", { xp: 1 })?.userName === "ghost");
  check("a new row starts at stranger", mod.getUserProfile("ghost")?.bond === "stranger");
}

console.log("=== J. facts ===");
{
  const mod = await loadProfile(join(dir, "api.db"), "api2");
  mod.addFacts("a1", ["ชอบกาแฟ", "ชอบกาแฟ", "  ", "อ่านนิยาย"], "2026-02-02T00:00:00Z");
  const facts = mod.getUserProfile("a1")!.facts;
  check("duplicates and blanks not added", facts.length === 3, facts.map((f: { text: string }) => f.text));
  check("newest first", facts[0].text === "ชอบกาแฟ" && facts[1].text === "อ่านนิยาย", facts.map((f: { text: string }) => f.text));
  check("timestamp stored", facts[0].timestamp === "2026-02-02T00:00:00Z", facts[0]);
  check("existing fact kept", facts.some((f: { text: string }) => f.text === "ชอบชา"), facts.map((f: { text: string }) => f.text));
  check("re-adding an existing fact adds nothing", mod.addFacts("a1", ["ชอบชา"]) === 0);
  check("addFacts returns how many landed", mod.addFacts("a1", ["ใหม่", "ชอบกาแฟ"]) === 1);
  check("removeFact deletes one, case-insensitively", mod.removeFact("a1", " ใหม่ ") === 1);
  check("removeFact on a missing fact removes nothing", mod.removeFact("a1", "ไม่มีจริง") === 0);
  check("removeFact on an unknown user is 0", mod.removeFact("nobody", "x") === 0);
  check("MAX_FACTS is 40", mod.MAX_FACTS === 40);
  const many = Array.from({ length: 60 }, (_, i) => `f${i}`);
  mod.setFacts("a1", many);
  check("setFacts caps at MAX_FACTS", mod.getUserProfile("a1")!.facts.length === mod.MAX_FACTS, mod.getUserProfile("a1")!.facts.length);
  check("setFacts replaces rather than appends", mod.getUserProfile("a1")!.facts.some((f: { text: string }) => f.text === "ชอบชา") === false);
  check("setFacts ignores a non-array", mod.setFacts("a1", "nope").length === 0);
}

console.log("=== K. setBond applies the ladder ===");
{
  const mod = await loadProfile(join(dir, "api.db"), "api3");
  mod.upsertUserProfile({ userId: "b1", userName: "B" });
  check("valid climb stored", mod.setBond("b1", "friend").bond === "friend");
  const refused = mod.setBond("b1", "nonsense");
  check("unknown rung refused", refused.ok === false && refused.bond === "friend", refused);
  check("refusal explains why", typeof refused.reason === "string" && refused.reason!.includes("nonsense"), refused.reason);
  mod.upsertUserProfile({ userId: "fam", userName: "Fam", bond: "sibling" });
  const capped = mod.setBond("fam", "lover");
  check("sibling cannot become lover", capped.ok === false && capped.bond === "sibling", capped);
  check("sibling stays sibling in the row", mod.getUserProfile("fam")?.bond === "sibling");
  mod.upsertUserProfile({ userId: "en", userName: "En", bond: "enemy" });
  check("enemy recovering to stranger lands on friend", mod.setBond("en", "stranger").bond === "friend");
  check("setBond on an unknown user creates the row", mod.setBond("newborn", "friend").ok === true && mod.getUserProfile("newborn")?.bond === "friend");
  check("setBond leaves other fields alone", mod.getUserProfile("b1")?.userName === "B");
  check("setBond can carry a new name", mod.setBond("b1", "close_friend", "Bee").profile?.userName === "Bee");
}

// ---------------------------------------------------------------- L. prompt blocks
console.log("=== L. prompt blocks (pipeline) ===");
process.env.SQLITE_PATH = join(dir, "blocks.db");
process.env.CHROMA_COLLECTION = "aira_profile_test_unused";
process.env.GEMINI1_API_KEYS = "bogus-key-for-offline-test";
process.env.GEMINI2_API_KEYS = "bogus-key-for-offline-test";
const pipe = await import("../src/pipeline/pipeline.js");
const blocks = await loadProfile(process.env.SQLITE_PATH, "blocks");
{
  const empty = pipe.profileBlock(null, "Yuuta");
  check("null profile still names the user", empty.includes("ชื่อ: Yuuta"), empty);
  check("null profile says no relationship data", empty.includes("ไม่มีข้อมูลความสัมพันธ์"));
  check("block is wrapped", empty.startsWith("<user_profile>") && empty.trimEnd().endsWith("</user_profile>"));
  check("no blank lines inside the block", !/\n\n/.test(empty), JSON.stringify(empty));

  blocks.upsertUserProfile({
    userId: "p1",
    userName: "Yuuta",
    nickname: ["จิ้มจุ้ม", "น้องยู"],
    bond: "crush",
    facts: [{ text: "ชอบชาเขียว", timestamp: "2026-08-30T20:01:47.957Z" }, { text: "ไม่มีเวลา" }],
    affection: 42,
    trust: 7,
    familiarity: 88,
    xp: 120,
  });
  const p1 = blocks.getUserProfile("p1")!;
  const block = pipe.profileBlock(p1);
  check("bond shown with Thai label and rank", block.includes("แอบชอบ") && block.includes("crush") && block.includes("ระดับ 3"), block);
  check("nicknames joined", block.includes("จิ้มจุ้ม, น้องยู"));
  check("facts rendered as bullets", block.includes("- [") && block.includes("ชอบชาเขียว"));
  check("fact timestamp converted to Thai time", block.includes("2026-08-31T03:01:47+07:00"), block);
  check("a fact with no timestamp has no bracket", block.includes("- ไม่มีเวลา"), block);
  check("stats present", block.includes("xp: 120") && block.includes("affection: 42") && block.includes("trust: 7") && block.includes("familiarity: 88"));
  check("she is told not to recite the numbers", block.includes("อย่านำไปพูดกับผู้ใช้"));
  check("no legacy field names leak into the block", !block.includes("affinity") && !block.includes("state:"));
  check("profile with an empty name falls back to the caller's name", pipe.profileBlock({ ...p1, userName: "" }, "Fallback").includes("ชื่อ: Fallback"));

  const state = pipe.stateBlock(p1);
  check("state block has the rung", state.includes("bond: crush") && state.includes("ระดับ 3"), state);
  check("state block has the numbers", state.includes("affection: 42") && state.includes("xp: 120"));
  check("state block wrapped", state.startsWith("<current_state>") && state.trimEnd().endsWith("</current_state>"));
  check("null state block explains itself", pipe.stateBlock(null).includes("ยังไม่มีข้อมูลผู้ใช้คนนี้"));
  check("state block carries no facts (Gemini 2 does not need them)", !state.includes("ชอบชาเขียว"));

  const rules = pipe.bondRulesBlock();
  check("rules list every rung", bonds.BOND_NAMES.every((n) => rules.includes(n)));
  check("rules wrapped", rules.startsWith("<bond_levels>") && rules.trimEnd().endsWith("</bond_levels>"));
}

// ---------------------------------------------------------------- M. execute operations
console.log("=== M. execute operations write to user_profiles ===");
{
  const op = (name: string, args: Record<string, unknown>) => ({ name, args });
  const run = (operations: unknown[], userId = "e1") =>
    pipe.applyExecute([{ name: "execute", args: { operations } }], userId, "2026-03-03T00:00:00Z", "Eunan");

  blocks.upsertUserProfile({ userId: "e1", userName: "Eunan", bond: "friend", facts: ["ของเดิม"] });

  await run([op("adjust_affection", { delta: 5 })]);
  check("adjust_affection writes affection", blocks.getUserProfile("e1")!.affection === 5, blocks.getUserProfile("e1")!.affection);
  await run([op("adjust_affinity", { delta: 3 })]);
  check("legacy alias adjust_affinity still lands on affection", blocks.getUserProfile("e1")!.affection === 8, blocks.getUserProfile("e1")!.affection);
  await run([op("adjust_trust", { delta: 4 })]);
  check("adjust_trust writes trust", blocks.getUserProfile("e1")!.trust === 4);
  await run([op("add_xp", { delta: 20 })]);
  check("add_xp writes xp", blocks.getUserProfile("e1")!.xp === 20, blocks.getUserProfile("e1")!.xp);
  check("stat writes never touch facts", blocks.getUserProfile("e1")!.facts[0].text === "ของเดิม", blocks.getUserProfile("e1")!.facts);

  await run([op("set_bond", { bond: "close_friend" })]);
  check("set_bond moves the rung", blocks.getUserProfile("e1")!.bond === "close_friend");
  await run([op("set_relationship", { state: "crush" })]);
  check("legacy alias set_relationship still works", blocks.getUserProfile("e1")!.bond === "crush", blocks.getUserProfile("e1")!.bond);
  await run([op("set_bond", { bond: "soulmate" })]);
  check("a legal climb is stored", blocks.getUserProfile("e1")!.bond === "soulmate");
  await run([op("set_bond", { bond: "nonsense" })]);
  check("a refused rung leaves the row alone", blocks.getUserProfile("e1")!.bond === "soulmate");
  await run([op("set_bond", { bond: "enemy" })]);
  await run([op("set_bond", { bond: "stranger" })]);
  check("recovering from enemy lands on friend", blocks.getUserProfile("e1")!.bond === "friend", blocks.getUserProfile("e1")!.bond);

  await run([op("add_facts", { facts: ["ชอบกาแฟ", "ชอบชาเขียว"] })]);
  check("add_facts appends both", blocks.getUserProfile("e1")!.facts.length === 3, blocks.getUserProfile("e1")!.facts.map((f: { text: string }) => f.text));
  await run([op("add_facts", { fact: "เดี่ยว ๆ ก็ได้" })]);
  check("add_facts accepts a bare `fact`", blocks.getUserProfile("e1")!.facts.length === 4);
  await run([op("add_facts", { facts: "ไม่ใช่ array ก็รับได้" })]);
  check("add_facts accepts a non-array", blocks.getUserProfile("e1")!.facts.length === 5);
  await run([op("add_facts", { facts: [null, 7, "  "] })]);
  check("add_facts ignores unusable entries", blocks.getUserProfile("e1")!.facts.length === 5);

  check("select_image returns the trimmed name", (await run([op("select_image", { image: " happy " })])) === "happy");
  check("blank image ignored", (await run([op("select_image", { image: "   " })])) === undefined);
  check("unknown operation ignored", (await run([op("ingest_memory_everything", {})])) === undefined);
  await run([op("add_xp", { delta: "abc" })]);
  check("non-finite delta ignored", blocks.getUserProfile("e1")!.xp === 20, blocks.getUserProfile("e1")!.xp);
  check("operations not an array -> nothing happens", (await run("nope" as unknown as unknown[])) === undefined);
  check("junk operation entries skipped", (await run([null, 7, "x", {}])) === undefined);
  check("missing args skipped", (await pipe.applyExecute([{ name: "execute", args: {} }], "e1", "t", "Eunan")) === undefined);
  check("wrong tool name ignored", (await pipe.applyExecute([{ name: "other_tool", args: { operations: [op("add_xp", { delta: 1 })] } }], "e1", "t", "Eunan")) === undefined);
  check("the last select_image in a batch wins", (await run([op("select_image", { image: "a" }), op("select_image", { image: "b" })])) === "b");
  check("operations on a fresh user create the row", (await run([op("add_xp", { delta: 3 })], "brand-new"), blocks.getUserProfile("brand-new")?.xp === 3));
  check("listUserProfiles sees the users", blocks.listUserProfiles(50).some((p: { userId: string }) => p.userId === "e1"));
  check("bondDescription labels a profile", blocks.bondDescription({ bond: "crush" }).includes("แอบชอบ"), blocks.bondDescription({ bond: "crush" }));
  check("bondDescription on null is honest", blocks.bondDescription(null) === "ไม่มีข้อมูลความสัมพันธ์");
}

console.log("=== N. the tool contract and the wiring ===");
{
  const src = readFileSync("src/pipeline/pipeline.ts", "utf8");
  for (const name of ["adjust_affection", "adjust_affinity", "add_xp", "set_bond", "set_relationship", "add_facts", "ingest_memory", "select_image"]) {
    check(`enum carries ${name}`, src.includes(`"${name}"`));
  }
  check("Gemini 2's instruction explains the operations", src.includes("adjust_affection (args:") && src.includes("set_bond (args:"));
  check("Gemini 2's instruction carries the ladder rules", src.includes("bondRulesBlock()"));
  check("Gemini 2 system prompt is still one stable string", /systemInstruction: gemini2SystemPrompt,/.test(src));
  // The bug this guards: `args` was a bare {type:"object"}, so the model sent five operations with
  // empty args every turn and nothing was ever written. The schema must name the fields.
  check("args schema describes delta", src.includes("delta:") && src.includes('type: "number"'));
  check("args schema describes bond/facts/text/image", ["bond:", "facts:", "text:", "image:"].every((k) => src.includes(k)));
  check("every operation the prompt mentions is in the enum", src.includes('"adjust_trust"'), "adjust_trust missing from EXECUTE_OPERATIONS");
  check("no romanticApproachCount left in the pipeline", !src.includes("romanticApproachCount"));
  check("no severeConflictCount left in the pipeline", !src.includes("severeConflictCount"));
  check("the old two-table read is gone", !src.includes("getRelationships"));
  check("the deprecated shim is gone", !src.includes("adjustRelationshipStats") && !existsSync("src/sql/relationship.ts"));
  check("nothing reads the relationships table any more", !/FROM relationships/.test(src));
  check("the profile block reaches Gemini 1's instruction", /systemInstruction: `\$\{systemPrompt\}\\n\\n\$\{identityBlock\}/.test(src));
}

rmSync(dir, { recursive: true, force: true });
console.log(fail ? `\n❌ ${fail} FAILED — ${pass} passed` : `\n✅ ALL PASS — ${pass} passed, 0 failed`);
process.exit(fail ? 1 : 0);
