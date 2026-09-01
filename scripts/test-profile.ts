// Tests for the simplified relationship model: one row per user, one number that moves (xp), the
// signals Gemini 2 reports as JSON, and the ladder that `deriveBond()` computes from them.
//   bun run scripts/test-profile.ts
//
// No network. Every case uses a throwaway SQLite file, and the applyState cases never set
// `ingest_memory` — that is the only field that would reach Chroma/Gemini.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const PROJECT_ROOT = join(import.meta.dirname, "..");

let pass = 0;
let fail = 0;
function check(label: string, cond: boolean, seen?: unknown): void {
  console.log(`  ${cond ? "✅" : "❌"} ${label}${cond || seen === undefined ? "" : ` -- got: ${JSON.stringify(seen)}`}`);
  cond ? pass++ : fail++;
}

const dir = mkdtempSync(join(tmpdir(), "aira-profile-test-"));
const { Database } = await import("bun:sqlite");

/*
 * The `select_image` enum is read from the `images/` directory, so these tests need a directory of
 * their own: pointing at the real one would make every assertion depend on how many pictures happen
 * to be checked in, and a picture added later would "break" an unrelated parser test.
 *
 * Set before anything imports `config` or `bot/images`: `IMAGES` in state-format.ts is a module-level
 * const, so the env var has to be in place before that module is first imported.
 */
const imagesDir = join(dir, "images");
mkdirSync(imagesDir, { recursive: true });
for (const name of ["neutral.jpg", "happy.jpg", "shy_smile.jpg", "angry.jpg", "sad.jpg"]) {
  writeFileSync(join(imagesDir, name), `fake-jpeg:${name}`);
}
writeFileSync(
  join(imagesDir, "manifest.json"),
  JSON.stringify({
    "neutral.jpg": "หน้าปกติ ยิ้มเล็กน้อย //group=calm_warm",
    "happy.jpg": "ยิ้มกว้าง ตาปิด — ใช้ตอนดีใจ //group=excited",
    // shy_smile.jpg is deliberately undocumented; notes.jpg has no file behind it.
    "notes.jpg": "ไฟล์ที่ไม่มีอยู่จริงบนดิสก์",
  }),
);
process.env.ISLA_IMAGES_DIR = imagesDir;
const IMG = "neutral.jpg";
const IMG_SHY = "shy_smile.jpg";

const { imageNames, imageCatalog, imageListForPrompt, isKnownImage, resolveEmotionImage, fetchEmotionImage } =
  await import("../src/bot/images.js");

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

// ---------------------------------------------------------------- A. the ladder engine
console.log("=== A. bond ladder + deriveBond (src/sql/bonds.ts) ===");
const bonds = await import("../src/sql/bonds.js");
check("every rung has a rank", bonds.BOND_NAMES.every((n) => Number.isInteger(bonds.BOND_LEVELS[n].level)));
check("enemy is the only negative rung", bonds.BOND_NAMES.filter((n) => bonds.BOND_LEVELS[n].level < 0).join() === "enemy");
check("sibling and family are capped at 3", bonds.isCappedBond("sibling") && bonds.isCappedBond("family") && !bonds.isCappedBond("crush"));
check("ladder text lists every rung", bonds.BOND_NAMES.every((n) => bonds.bondLadderText().includes(n)));
check("threshold text lists every rung", bonds.BOND_NAMES.every((n) => bonds.bondLadderWithThresholds().includes(n)));
check("threshold text states the xp gates", bonds.bondLadderWithThresholds().includes("xp >= 500") && bonds.bondLadderWithThresholds().includes("xp <= -150"));

// --- the footer's `[X Unlocked]` badge reads these two, so the rules live next to the ladder ---
check("every announceable rung has an unlock label", ["friend", "close_friend", "crush", "lover", "soulmate", "sibling", "family"]
  .every((n) => bonds.bondUnlockLabel(n) !== ""));
check("stranger is never announced", bonds.bondUnlockLabel("stranger") === "");
check("enemy is never announced -- a fall-out is not a condition passed", bonds.bondUnlockLabel("enemy") === "");
check("an unknown rung has no label", bonds.bondUnlockLabel("bestie") === "" && bonds.bondUnlockLabel(null) === "");
check("unlock labels are title-case English", bonds.bondUnlockLabel("close_friend") === "Close Friend" && bonds.bondUnlockLabel("lover") === "Lover");
check("a promotion is an unlock", bonds.isBondUnlock("close_friend", "lover") && bonds.isBondUnlock(null, "friend"));
check("holding a rung is not an unlock", !bonds.isBondUnlock("lover", "lover") && !bonds.isBondUnlock("friend", "friend"));
check("a demotion is not an unlock", !bonds.isBondUnlock("close_friend", "friend") && !bonds.isBondUnlock("crush", "stranger"));
check("falling out to enemy is silent", !bonds.isBondUnlock("friend", "enemy"));
check("climbing back out of enemy to friend IS an unlock -- a rung newly reached", bonds.isBondUnlock("enemy", "friend"));
check("a sideways move onto a new rung IS an unlock", bonds.isBondUnlock("crush", "family") && bonds.isBondUnlock("crush", "sibling"));
check("an unknown target is never an unlock", !bonds.isBondUnlock("friend", "bestie") && !bonds.isBondUnlock("friend", null));

check("xp -> stranger in the band", bonds.bondForXp(0) === "stranger" && bonds.bondForXp(149) === "stranger" && bonds.bondForXp(-149) === "stranger");
check("xp -> friend at 150", bonds.bondForXp(150) === "friend");
check("xp -> close_friend at 500", bonds.bondForXp(500) === "close_friend");
check("xp -> enemy at -150", bonds.bondForXp(-150) === "enemy");
check("xp below -150 stays enemy", bonds.bondForXp(-900) === "enemy");

const d = (from: string | null, xp: number, signals: { flirtCount?: number; approvals?: Record<string, boolean> }) =>
  bonds.deriveBond(from, xp, { flirtCount: signals.flirtCount ?? 0, approvals: signals.approvals as never });

check("new user at 0 xp is stranger", d(null, 0, {}).bond === "stranger");
check("unknown current bond is treated as stranger", d("nonsense", 200, {}).bond === "friend");
check("friend at 500 becomes close_friend", d("friend", 500, {}).bond === "close_friend");
check("close_friend at 500 without flirts stays close_friend", d("close_friend", 500, { flirtCount: 4 }).bond === "close_friend");
check("close_friend + 5 flirts becomes crush", d("close_friend", 500, { flirtCount: 5 }).bond === "crush");
check("crush needs 5 flirts, not more", d("stranger", 600, { flirtCount: 5 }).bond === "crush");
check("a crush does not decay on a bad week", d("crush", 120, {}).bond === "crush");
// The live case after the migration: Farris was already `lover` at xp 19 with no flirt history,
// because the OLD engine granted rungs the new one gates behind 500 xp + 5 flirts. A rung granted by
// a decision must survive the schema change — otherwise the first message after the restart silently
// dumps an established lover back to stranger.
check("a pre-existing lover at low xp is grandfathered, not demoted", d("lover", 19, { flirtCount: 0 }).bond === "lover");
check("a pre-existing soulmate at low xp is grandfathered", d("soulmate", 19, { flirtCount: 0 }).bond === "soulmate");
check("a grandfathered lover still cannot be skipped to soulmate without approval", d("lover", 19, { flirtCount: 0, approvals: { soulmate: false } }).bond === "lover");
check("close_friend does decay below its bar", d("close_friend", 200, {}).bond === "friend");
check("friend does not decay inside its band", d("friend", 160, {}).bond === "friend");
check("enemy at xp <= -150", d("friend", -200, {}).bond === "enemy");
check("recovering from enemy jumps to friend, never stranger", d("enemy", 0, {}).bond === "friend");
check("recovering from enemy jumps to friend even with high xp", d("enemy", 600, { flirtCount: 5 }).bond === "friend");
check("the jump keeps the xp, so the next turn climbs on", d("friend", 600, { flirtCount: 5 }).bond === "crush");
check("lover needs the approval", d("crush", 900, {}).bond === "crush");
check("lover granted when a crush proposes and she agrees", d("crush", 900, { approvals: { lover: true } }).bond === "lover");
check("lover proposal from a stranger is refused", d("stranger", 900, { approvals: { lover: true } }).bond === "close_friend");
check("soulmate needs the approval", d("lover", 900, {}).bond === "lover");
check("soulmate granted when a lover proposes marriage", d("lover", 900, { approvals: { soulmate: true } }).bond === "soulmate");
check("soulmate cannot skip lover", d("crush", 900, { approvals: { soulmate: true } }).bond === "crush");
check("proposal below the xp bar is pending, not lost", d("crush", 400, { approvals: { lover: true } }).bond === "crush");
check("pending reason says so", d("crush", 400, { approvals: { lover: true } }).reason.includes("pending: lover"));
check("a pending proposal is consumed once xp arrives", d("crush", 500, { approvals: { lover: true } }).consumed.join() === "lover");
check("sibling granted from a friend", d("friend", 500, { approvals: { sibling: true } }).bond === "sibling");
check("family granted from a stranger", d("stranger", 700, { approvals: { family: true } }).bond === "family");
check("family needs xp too", d("stranger", 100, { approvals: { family: true } }).bond === "stranger");
check("sibling can never become lover", d("sibling", 900, { approvals: { lover: true } }).bond === "sibling");
check("family can never become soulmate", d("family", 900, { approvals: { soulmate: true, lover: true } }).bond === "family");
check("family falling out can reach enemy", d("family", -200, {}).bond === "enemy");
check("a capped rung recovering from low xp cannot climb into romance", d("sibling", 900, { flirtCount: 9 }).bond === "sibling");
check("changed flag only when the rung moved", d("friend", 200, {}).changed === false && d("friend", 500, {}).changed === true);
check("enemy entry reports changed", d("friend", -160, {}).changed === true);
check("no bond name is ever invented", bonds.BOND_NAMES.includes(d("crush", 900, { approvals: { lover: true } }).bond));

// ---------------------------------------------------------------- B. migration
console.log("=== B. migration from the pre-simplification schema ===");
const legacyFile = join(dir, "legacy.db");
{
  const raw = new Database(legacyFile);
  raw.run(`CREATE TABLE user_profiles (
    user_id TEXT PRIMARY KEY, name TEXT, nicknames_json TEXT, bond TEXT, xp INTEGER,
    trust REAL, affection REAL, familiarity REAL, facts_json TEXT
  )`);
  raw.run(`INSERT INTO user_profiles (user_id, name, nicknames_json, bond, xp, trust, affection, familiarity, facts_json) VALUES
    ('u1', 'Yuuta', '["จิ้มจุ้ม","น้อง"]', 'close_friend', 120, 7, 42.5, 88, '["ชอบชา","อ่านหนังสือ"]'),
    ('u2', 'Farris', '[]', 'stranger', 10, 0, 3, 0, '[]')`);
  raw.close();
}
const mig = await loadProfile(legacyFile, "legacy");
{
  const raw = new Database(legacyFile);
  const cols = columnNames(raw, "user_profiles");
  check("retired stats dropped", !cols.includes("trust") && !cols.includes("affection") && !cols.includes("familiarity"), cols);
  check("legacy name column dropped", !cols.includes("name") && !cols.includes("nicknames_json"), cols);
  check("new columns added", ["flirt_count", "approved_lover", "approved_soulmate", "approved_sibling", "approved_family"].every((c) => cols.includes(c)), cols);
  raw.close();

  const u1 = mig.getUserProfile("u1");
  check("identity survived", u1?.userName === "Yuuta" && JSON.stringify(u1?.nickname) === JSON.stringify(["จิ้มจุ้ม", "น้อง"]), u1);
  check("bond survived", u1?.bond === "close_friend", u1?.bond);
  check("xp survived", u1?.xp === 120, u1?.xp);
  check("facts survived and are {text,timestamp}", u1?.facts.length === 2 && u1.facts[0].text === "ชอบชา", u1?.facts);
  check("flirt count starts at 0", u1?.flirtCount === 0, u1?.flirtCount);
  check("no approvals pending", Object.values(u1!.approvals).every((v) => v === false), u1?.approvals);
  check("the deleted stats are simply gone from the object", !("trust" in u1!) && !("affection" in u1!) && !("familiarity" in u1!));
}

console.log("=== C. migration is idempotent ===");
{
  const again = mig.migrateUserProfiles();
  check("second run creates nothing", again.created === false, again);
  const u1 = mig.getUserProfile("u1");
  check("data survives the second run", u1?.bond === "close_friend" && u1?.xp === 120 && u1.nickname.length === 2, u1);
  const raw = new Database(legacyFile);
  check("row count unchanged", (raw.query(`SELECT COUNT(*) c FROM user_profiles`).get() as { c: number }).c === 2);
  raw.close();
}

console.log("=== D. the older two-table layout still migrates ===");
{
  const two = join(dir, "two-table.db");
  const raw = new Database(two);
  raw.run(`CREATE TABLE user_profiles (user_id TEXT PRIMARY KEY, name TEXT, nicknames_json TEXT, facts_json TEXT)`);
  raw.run(`INSERT INTO user_profiles VALUES ('u1','Yuuta','["จิ้มจุ้ม"]','["ชอบชา"]')`);
  raw.run(`CREATE TABLE relationships (user_id TEXT PRIMARY KEY, user_name TEXT, state TEXT, xp INTEGER, affinity REAL)`);
  raw.run(`INSERT INTO relationships VALUES ('u1','Yuuta','crush',7,9.5), ('u3','Shadow','stranger',0,0)`);
  raw.close();
  const mod = await loadProfile(two, "two");
  const raw2 = new Database(two);
  check("relationships folded in and dropped", !tableNames(raw2).includes("relationships"), tableNames(raw2));
  raw2.close();
  const u1 = mod.getUserProfile("u1");
  check("state -> bond, xp -> xp", u1?.bond === "crush" && u1?.xp === 7, u1);
  check("affinity is NOT carried over (xp is the only number)", u1?.xp === 7 && !("affection" in u1!));
  check("relationship-only user gets a row", mod.getUserProfile("u3")?.userName === "Shadow");
}

console.log("=== E. AIRA_KEEP_LEGACY_SCHEMA: additive only ===");
{
  const liveFile = join(dir, "live.db");
  const raw = new Database(liveFile);
  raw.run(`CREATE TABLE user_profiles (user_id TEXT PRIMARY KEY, name TEXT, nicknames_json TEXT, facts_json TEXT, trust REAL, affection REAL, familiarity REAL)`);
  raw.run(`INSERT INTO user_profiles VALUES ('u1','Yuuta','["จิ้มจุ้ม"]','["ชอบชา"]',1,2,3)`);
  raw.close();
  process.env.AIRA_KEEP_LEGACY_SCHEMA = "1";
  const live = await loadProfile(liveFile, "live");
  const raw2 = new Database(liveFile);
  const cols = columnNames(raw2, "user_profiles");
  check("legacy columns kept while a live process uses them", cols.includes("name") && cols.includes("affection") && cols.includes("trust"), cols);
  check("new columns added alongside", cols.includes("flirt_count") && cols.includes("bond"), cols);
  raw2.close();
  check("merged data readable", live.getUserProfile("u1")?.userName === "Yuuta");
  check("a write works with legacy columns present", live.applyTurnState({ userId: "u1", userName: "Yuuta", affinity: 10 }).xp === 10, live.getUserProfile("u1"));
  delete process.env.AIRA_KEEP_LEGACY_SCHEMA;

  const done = await loadProfile(liveFile, "finish");
  done.migrateUserProfiles();
  const raw3 = new Database(liveFile);
  const after = columnNames(raw3, "user_profiles");
  check("a restart drops them", !after.includes("name") && !after.includes("affection"), after);
  raw3.close();
  check("and the written state survived", done.getUserProfile("u1")?.xp === 10, done.getUserProfile("u1"));
}

console.log("=== F. a brand-new database has exactly the new shape ===");
{
  const freshFile = join(dir, "fresh.db");
  const fresh = await loadProfile(freshFile, "fresh");
  const raw = new Database(freshFile);
  const cols = columnNames(raw, "user_profiles");
  check(
    "columns are the simplified set",
    cols.join(",") === "user_id,user_name,nickname_json,bond,xp,flirt_count,approved_lover,approved_soulmate,approved_sibling,approved_family,facts_json",
    cols,
  );
  raw.close();
  check("writes work on a new table", fresh.upsertUserProfile({ userId: "n1", userName: "New" })?.userName === "New");
  check("a new row defaults to stranger/0/0/no approvals", (() => {
    const p = fresh.getUserProfile("n1")!;
    return p.bond === "stranger" && p.xp === 0 && p.flirtCount === 0 && !Object.values(p.approvals).some(Boolean);
  })(), fresh.getUserProfile("n1"));
}

console.log("=== G. junk in a row degrades instead of throwing ===");
{
  const junk = join(dir, "junk.db");
  const raw = new Database(junk);
  raw.run(`CREATE TABLE user_profiles (user_id TEXT PRIMARY KEY, name TEXT, nicknames_json TEXT, facts_json TEXT)`);
  raw.close();
  const mod = await loadProfile(junk, "junk");
  mod.upsertUserProfile({
    userId: "j1",
    userName: "Junk",
    nickname: ["ok", "  ", 42 as unknown as string],
    bond: "not_a_rung" as never,
    flirtCount: -5,
    approvals: { lover: "yes" as never, nonsense: true as never },
    facts: ["plain", { text: "obj", timestamp: "2026-01-01T00:00:00Z" }, { nope: 1 }, "", 7] as never,
  });
  const row = mod.getUserProfile("j1");
  check("bad bond falls back to stranger", row?.bond === "stranger", row?.bond);
  check("negative flirt count clamps to 0", row?.flirtCount === 0, row?.flirtCount);
  check("unknown approval keys ignored, real ones coerced", row?.approvals.lover === true && !("nonsense" in row!.approvals), row?.approvals);
  check("nicknames keep only non-empty strings", JSON.stringify(row?.nickname) === JSON.stringify(["ok"]), row?.nickname);
  check("facts keep both shapes and drop junk", row?.facts.length === 2 && row.facts[1].text === "obj", row?.facts);

  const raw2 = new Database(junk);
  // `xp` is NOT NULL, so junk has to arrive the way SQLite allows it: a text value in a numeric
  // column (dynamic typing), which is what a hand-edited or half-migrated row actually looks like.
  raw2.run(`UPDATE user_profiles SET nickname_json = '{not json', facts_json = '[{"text":""},"  "]', approved_lover = 'junk', xp = 'nonsense' WHERE user_id = 'j1'`);
  raw2.close();
  const reread = mod.getUserProfile("j1")!;
  check("broken nickname_json becomes []", reread.nickname.length === 0, reread.nickname);
  check("facts with no text are dropped", reread.facts.length === 0, reread.facts);
  check("a non-numeric approval flag reads false", reread.approvals.lover === false, reread.approvals);
  check("null xp reads 0", reread.xp === 0, reread.xp);
}

// ---------------------------------------------------------------- H. the state writer
console.log("=== H. applyTurnState is the only path onto the ladder ===");
{
  const mod = await loadProfile(join(dir, "state.db"), "state");
  const turn = (userId: string, patch: { affinity: number; isFlirt?: boolean; approvals?: Record<string, boolean>; userName?: string }) =>
    mod.applyTurnState({ userId, userName: "Yuuta", ...patch });
  /** Grind xp up to `target` in legal +10 steps so the band maths stays honest. */
  const grind = (userId: string, target: number) => {
    for (let guard = 0; guard < 200 && (mod.getUserProfile(userId)?.xp ?? 0) < target; guard++) {
      turn(userId, { affinity: 10 });
    }
    return mod.getUserProfile(userId)!;
  };

  const first = turn("s1", { affinity: 10 });
  check("first contact creates the row and moves xp", first.xp === 10 && first.profile?.userName === "Yuuta", first);
  check("a normal turn keeps a stranger a stranger", first.after === "stranger" && first.before === "stranger");
  check("xp accumulates", turn("s1", { affinity: 10 }).xp === 20);

  check("150 xp reaches friend", grind("s1", 150).bond === "friend", mod.getUserProfile("s1"));
  check("500 xp reaches close_friend", grind("s1", 500).bond === "close_friend", mod.getUserProfile("s1"));
  check("no flirts yet, so no crush", mod.getUserProfile("s1")?.flirtCount === 0);
  check("close_friend at 500 xp without flirts holds", turn("s1", { affinity: 10 }).after === "close_friend");

  check("4 accepted flirts is not enough", (() => {
    for (let i = 0; i < 4; i++) turn("s1", { affinity: 10, isFlirt: true });
    return mod.getUserProfile("s1")?.flirtCount === 4 && mod.getUserProfile("s1")?.bond === "close_friend";
  })(), mod.getUserProfile("s1"));
  const fifth = turn("s1", { affinity: 10, isFlirt: true });
  check("the fifth accepted flirt makes it crush", fifth.after === "crush" && fifth.before === "close_friend", fifth);
  check("derivation explains the rule", fifth.derivation.reason.includes("5 accepted flirts"), fifth.derivation.reason);
  check("that turn reports BOTH a flirt and an unlock", fifth.flirtDelta === 1 && fifth.bondUnlocked === true, fifth);
  check("a flirt with no proposal stays crush", turn("s1", { affinity: 10, isFlirt: true, approvals: { lover: false } }).after === "crush");
  check("a held rung is not an unlock, even with a flirt", (() => {
    const held = turn("s1", { affinity: 10, isFlirt: true });
    return held.after === "crush" && held.bondUnlocked === false && held.flirtDelta === 1;
  })());

  const proposal = turn("s1", { affinity: 10, approvals: { lover: true } });
  check("an accepted proposal promotes to lover", proposal.after === "lover", proposal);
  check("the flag is consumed, not left pending", mod.getUserProfile("s1")?.approvals.lover === false, mod.getUserProfile("s1")?.approvals);
  check("a second yes changes nothing", turn("s1", { affinity: 10, approvals: { lover: true } }).after === "lover");
  const marriage = turn("s1", { affinity: 10, approvals: { soulmate: true } });
  check("marriage accepted while lover -> soulmate", marriage.after === "soulmate", marriage);
  check("soulmate is the top", turn("s1", { affinity: 50, approvals: { soulmate: true, lover: true } }).after === "soulmate");
  check("a soulmate does not decay on a bad week", grind("s1", 0).bond === "soulmate", mod.getUserProfile("s1"));

  // A yes the ladder cannot grant yet must not be forgotten.
  turn("late", { affinity: 10 });
  const early = turn("late", { affinity: 10, approvals: { family: true } });
  check("a proposal below the xp bar does not move the rung", early.after === "stranger", early);
  check("but the yes is stored as pending", mod.getUserProfile("late")?.approvals.family === true, mod.getUserProfile("late")?.approvals);
  grind("late", 500);
  const later = turn("late", { affinity: 0 });
  check("the pending yes fires once xp is there", later.after === "family", later);
  check("and is then cleared", mod.getUserProfile("late")?.approvals.family === false);

  // Enemy and the one-way door out.
  for (let i = 0; i < 20; i++) turn("foe", { affinity: -10 });
  check("sustained negativity makes an enemy", mod.getUserProfile("foe")?.bond === "enemy", mod.getUserProfile("foe"));
  check("one good turn is not enough to leave enemy", turn("foe", { affinity: 10 }).after === "enemy");
  grind("foe", -149);
  check("recovery jumps straight to friend", mod.getUserProfile("foe")?.bond === "friend", mod.getUserProfile("foe"));
  check("never back through stranger", grind("foe", 0).bond === "friend", mod.getUserProfile("foe"));
  check("and it holds while xp is still in the stranger band", turn("foe", { affinity: 10 }).after === "friend");

  // A capped rung is permanent for romance.
  grind("cousin", 600);
  check("xp alone does not make family", mod.getUserProfile("cousin")?.bond === "close_friend", mod.getUserProfile("cousin"));
  turn("cousin", { affinity: 0, approvals: { family: true } });
  check("family accepted", mod.getUserProfile("cousin")?.bond === "family");
  const attempted = turn("cousin", { affinity: 0, approvals: { lover: true, soulmate: true } });
  check("family cannot become lover even with both yeses", attempted.after === "family", attempted);
  check("and the romantic flags are not consumed", mod.getUserProfile("cousin")?.approvals.lover === true);
  for (let guard = 0; guard < 200 && (mod.getUserProfile("cousin")?.xp ?? 0) > -150; guard++) turn("cousin", { affinity: -10 });
  check("family can still fall out to enemy", mod.getUserProfile("cousin")?.bond === "enemy", mod.getUserProfile("cousin"));

  check("flirt count never goes negative", (() => {
    mod.upsertUserProfile({ userId: "neg", userName: "Neg", flirtCount: 3 });
    mod.applyTurnState({ userId: "neg", affinity: 0, isFlirt: false });
    return mod.getUserProfile("neg")?.flirtCount === 3;
  })());
  check("a turn with affinity 0 still records flirts", mod.applyTurnState({ userId: "neg", affinity: 0, isFlirt: true }).flirtCount === 4);
  check("forceBond is the human override", mod.forceBond("neg", "friend")?.bond === "friend");
  check("forceBond refuses a nonsense rung", mod.forceBond("neg", "nope" as never) === null);
  check("nothing exports a model-facing bond setter", !("setBond" in mod) && !("adjustProfileStats" in mod));
}

// ---------------------------------------------------------------- I. facts
console.log("=== I. facts ===");
{
  const mod = await loadProfile(join(dir, "state.db"), "facts");
  mod.addFacts("s1", ["ชอบกาแฟ", "ชอบกาแฟ", "  ", "อ่านนิยาย"], "2026-02-02T00:00:00Z");
  const facts = mod.getUserProfile("s1")!.facts;
  check("duplicates and blanks not added", facts.filter((f: { text: string }) => f.text === "ชอบกาแฟ").length === 1, facts.map((f: { text: string }) => f.text));
  check("the batch lands newest-batch-first", facts[0].text === "ชอบกาแฟ" && facts[1].text === "อ่านนิยาย", facts.map((f: { text: string }) => f.text));
  check("timestamp stored", facts[0].timestamp === "2026-02-02T00:00:00Z", facts[0]);
  check("addFacts returns how many landed", mod.addFacts("s1", ["ใหม่", "ชอบกาแฟ"]) === 1);
  check("removeFact deletes one, case-insensitively", mod.removeFact("s1", " ใหม่ ") === 1);
  check("removeFact on a missing fact removes nothing", mod.removeFact("s1", "ไม่มีจริง") === 0);
  check("removeFact on an unknown user is 0", mod.removeFact("nobody", "x") === 0);
  check("MAX_FACTS is 40", mod.MAX_FACTS === 40);
  mod.setFacts("s1", Array.from({ length: 60 }, (_, i) => `f${i}`));
  check("setFacts caps at MAX_FACTS", mod.getUserProfile("s1")!.facts.length === mod.MAX_FACTS);
  check("setFacts ignores a non-array", mod.setFacts("s1", "nope").length === 0);
  check("listUserProfiles sees the users", mod.listUserProfiles(50).some((p: { userId: string }) => p.userId === "s1"));
  check("bondDescription labels a profile", mod.bondDescription({ bond: "crush" }).includes("แอบชอบ"));
  check("bondDescription on null is honest", mod.bondDescription(null) === "ไม่มีข้อมูลความสัมพันธ์");
}

// ---------------------------------------------------------------- J. the JSON contract
console.log("=== J. parseIslaState — Gemini 2's JSON reply ===");
{
  const st = await import("../src/gemini/state-format.js");
  const parse = (raw: string, bond = "stranger") => st.parseIslaState(raw, bond);

  check("schema requires only the always-meaningful fields", JSON.stringify(st.ISLA_STATE_SCHEMA.required) === JSON.stringify(["affinity", "select_image"]), st.ISLA_STATE_SCHEMA.required);
  check("schema offers the image enum from the directory", (st.ISLA_STATE_SCHEMA.properties.select_image.enum as readonly string[]).includes(IMG_SHY));
  check("schema offers every file in the directory", imageNames().every((n: string) => (st.ISLA_STATE_SCHEMA.properties.select_image.enum as readonly string[]).includes(n)), st.ISLA_STATE_SCHEMA.properties.select_image.enum);
  check("schema offers an explicit opt-out", (st.ISLA_STATE_SCHEMA.properties.select_image.enum as readonly string[]).includes("none"));
  check("schema has no bond field", !("bond" in st.ISLA_STATE_SCHEMA.properties) && !("state" in st.ISLA_STATE_SCHEMA.properties));
  check("schema names every key the parser accepts", ["affinity", "is_flirt", "approve_lover", "approve_soulmate", "approve_sibling", "approve_family", "select_image", "add_facts", "add_nicknames", "ingest_memory"].every((k) => k in st.ISLA_STATE_SCHEMA.properties));

  check("required fields at stranger", st.requiredFieldsFor("stranger").join(",") === "affinity,selectImage,isFlirt", st.requiredFieldsFor("stranger"));
  check("required fields at crush adds approve_lover", st.requiredFieldsFor("crush").includes("approveLover"));
  check("required fields at lover adds approve_soulmate", st.requiredFieldsFor("lover").includes("approveSoulmate"));
  check("enemy is not asked about flirting", st.requiredFieldsFor("enemy").join(",") === "affinity,selectImage", st.requiredFieldsFor("enemy"));
  check("sibling/family are not asked about flirting", !st.romanticallyAvailable("sibling") && !st.romanticallyAvailable("family") && !st.romanticallyAvailable("enemy"));
  check("crush/lover/stranger can still become romantic", st.romanticallyAvailable("crush") && st.romanticallyAvailable("stranger"));

  const good = parse('{"affinity":12,"is_flirt":false,"select_image":"happy.jpg","add_facts":["ชอบชา"],"ingest_memory":""}');
  check("clean reply parses", good.parsed && good.affinity === 12 && good.selectImage === "happy.jpg", good);
  check("facts read as a list", good.addFacts.length === 1 && good.addFacts[0] === "ชอบชา");
  check("empty memory is a legitimate answer", good.ingestMemory === "");
  check("no warnings on a complete reply", good.warnings.length === 0, good.warnings);

  check("code fences tolerated", parse('```json\n{"affinity":10,"select_image":"neutral.jpg"}\n```').affinity === 10);
  check("prose around the object tolerated", parse('here you go: {"affinity":10,"select_image":"neutral.jpg"} thanks').affinity === 10);
  check("nested braces inside a string do not cut the object", parse('{"affinity":10,"select_image":"neutral.jpg","ingest_memory":"เขาบอกว่า {ชอบ} เรา"}').ingestMemory === "เขาบอกว่า {ชอบ} เรา");

  // The floor: any non-negative turn is worth at least +10.
  check("a positive turn below the floor is raised", parse('{"affinity":3,"select_image":"neutral.jpg"}').affinity === st.AFFINITY_NEUTRAL_FLOOR);
  check("the floor is 10", st.AFFINITY_NEUTRAL_FLOOR === 10);
  check("exactly the floor is untouched", parse('{"affinity":10,"select_image":"neutral.jpg"}').affinity === 10);
  check("negative values are NOT raised", parse('{"affinity":-3,"select_image":"neutral.jpg"}').affinity === -3);
  check("zero stays zero", parse('{"affinity":0,"select_image":"neutral.jpg"}').affinity === 0);
  check("clamped to +100", parse('{"affinity":5000,"select_image":"neutral.jpg"}').affinity === 100);
  check("clamped to -100", parse('{"affinity":-5000,"select_image":"neutral.jpg"}').affinity === -100);
  check("clamping is reported", parse('{"affinity":5000,"select_image":"neutral.jpg"}').warnings.some((w: string) => w.includes("clamped")));
  check("a numeric string is read", parse('{"affinity":"15","select_image":"neutral.jpg"}').affinity === 15);
  check("missing affinity means no change and warns", (() => {
    const r = parse('{"select_image":"neutral.jpg"}');
    return r.affinity === 0 && r.parsed && r.warnings.some((w: string) => w.includes("missing affinity"));
  })(), parse('{"select_image":"neutral.jpg"}').warnings);

  // is_flirt
  check("is_flirt true read at stranger", parse('{"affinity":10,"is_flirt":true,"select_image":"neutral.jpg"}', "stranger").isFlirt === true);
  check("is_flirt false is a real answer, not a missing one", (() => {
    const r = parse('{"affinity":10,"is_flirt":false,"select_image":"neutral.jpg"}', "crush");
    return r.isFlirt === false && !r.warnings.some((w: string) => w.includes("is_flirt"));
  })(), parse('{"affinity":10,"is_flirt":false,"select_image":"neutral.jpg"}', "crush").warnings);
  check("missing is_flirt at a romantic rung warns and means false", (() => {
    const r = parse('{"affinity":10,"select_image":"neutral.jpg"}', "crush");
    return r.isFlirt === false && r.warnings.some((w: string) => w.includes("missing is_flirt"));
  })(), parse('{"affinity":10,"select_image":"neutral.jpg"}', "crush").warnings);
  check("is_flirt not expected at enemy", (() => {
    const r = parse('{"affinity":10,"select_image":"neutral.jpg"}', "enemy");
    return r.isFlirt === undefined && r.warnings.length === 0;
  })(), parse('{"affinity":10,"select_image":"neutral.jpg"}', "enemy").warnings);
  check("a volunteered is_flirt at sibling is ignored with a note", (() => {
    const r = parse('{"affinity":10,"is_flirt":true,"select_image":"neutral.jpg"}', "sibling");
    return r.isFlirt === undefined && r.warnings.some((w: string) => w.includes("ignored"));
  })(), parse('{"affinity":10,"is_flirt":true,"select_image":"neutral.jpg"}', "sibling").warnings);
  check("Thai yes/no words coerced", parse('{"affinity":10,"is_flirt":"ไม่ใช่","select_image":"neutral.jpg"}', "crush").isFlirt === false);

  // approvals
  check("approve_lover read at crush", parse('{"affinity":10,"approve_lover":true,"select_image":"neutral.jpg"}', "crush").approveLover === true);
  check("missing approve_lover at crush warns and means false", (() => {
    const r = parse('{"affinity":10,"select_image":"neutral.jpg"}', "crush");
    return r.approveLover === false && r.warnings.some((w: string) => w.includes("missing approve_lover"));
  })(), parse('{"affinity":10,"select_image":"neutral.jpg"}', "crush").warnings);
  check("approve_soulmate only required at lover", (() => {
    const missing = parse('{"affinity":10,"select_image":"neutral.jpg"}', "lover");
    return missing.approveSoulmate === false && missing.warnings.some((w: string) => w.includes("missing approve_soulmate"));
  })(), parse('{"affinity":10,"select_image":"neutral.jpg"}', "lover").warnings);
  check("approve_lover at stranger is not demanded", (() => {
    const r = parse('{"affinity":10,"select_image":"neutral.jpg"}', "stranger");
    return r.approveLover === undefined && !r.warnings.some((w: string) => w.includes("approve_lover"));
  })(), parse('{"affinity":10,"select_image":"neutral.jpg"}', "stranger").warnings);
  check("a volunteered yes outside its rung is still recorded", parse('{"affinity":10,"approve_family":true,"select_image":"neutral.jpg"}', "friend").approveFamily === true);

  // select_image
  check("unknown image dropped with a warning", (() => {
    const r = parse('{"affinity":10,"select_image":"crying"}');
    return r.selectImage === "" && r.warnings.some((w: string) => w.includes("unknown select_image"));
  })(), parse('{"affinity":10,"select_image":"crying"}').warnings);
  check("missing image warns but keeps the turn", (() => {
    const r = parse('{"affinity":10}');
    return r.parsed && r.selectImage === "" && r.warnings.some((w: string) => w.includes("no select_image"));
  })(), parse('{"affinity":10}').warnings);
  check("image name trimmed", parse('{"affinity":10,"select_image":"  shy_smile.jpg  "}').selectImage === "shy_smile.jpg");
  check("a path prefix is tolerated", parse('{"affinity":10,"select_image":"images/happy.jpg"}').selectImage === "happy.jpg");
  check("`none` is a clean answer, not a warning", (() => {
    const r = parse('{"affinity":10,"select_image":"none"}');
    return r.selectImage === "" && !r.warnings.some((w: string) => w.includes("select_image"));
  })(), parse('{"affinity":10,"select_image":"none"}').warnings);
  check("a manifest entry with no file behind it is refused", (() => {
    const r = parse('{"affinity":10,"select_image":"notes.jpg"}');
    return r.selectImage === "" && r.warnings.some((w: string) => w.includes("unknown select_image"));
  })(), parse('{"affinity":10,"select_image":"notes.jpg"}').warnings);
  check("path traversal is refused", parse('{"affinity":10,"select_image":"../../etc/passwd"}').selectImage === "");
  check("nicknames read as a list", parse(`{"affinity":10,"select_image":"${IMG}","add_nicknames":["คนโปรด","คนขี้แกล้ง"]}`).addNicknames.join(",") === "คนโปรด,คนขี้แกล้ง");
  check("nickname alias `nicknames` accepted", parse(`{"affinity":10,"select_image":"${IMG}","nicknames":["ยู"]}`).addNicknames.join() === "ยู");
  check("absent nicknames are an empty list", parse(`{"affinity":10,"select_image":"${IMG}"}`).addNicknames.length === 0);

  // facts / memory
  check("a bare string becomes one fact", parse('{"affinity":10,"select_image":"neutral.jpg","add_facts":"ชื่อเล่นคือยู"}').addFacts.length === 1);
  check("junk fact entries dropped", parse('{"affinity":10,"select_image":"neutral.jpg","add_facts":[null,7,"  ","จริง"]}', "stranger").addFacts.join() === "จริง");
  check("object facts read their text", parse('{"affinity":10,"select_image":"neutral.jpg","add_facts":[{"text":"ชอบชา"}]}').addFacts.join() === "ชอบชา");
  check("memory alias `memory` accepted", parse('{"affinity":10,"select_image":"neutral.jpg","memory":"งานวันเกิด"}').ingestMemory === "งานวันเกิด");

  // total failures must not throw
  for (const junk of ["", "   ", "no json here", "{", "{not json}", "[1,2]", "null", "[]"]) {
    const r = parse(junk, "crush");
    check(`junk reply "${junk.slice(0, 10)}" degrades to a no-op state`, r.parsed === false && r.affinity === 0 && r.selectImage === "" && r.addFacts.length === 0 && r.isFlirt === undefined, r);
  }
  check("IMAGES is the directory listing plus `none`", st.IMAGES.length === imageNames().length + 1 && st.IMAGES.includes(IMG) && st.IMAGES.includes("none"), st.IMAGES);
}

// ---------------------------------------------------------------- K. prompt blocks
console.log("=== K. prompt blocks (pipeline) ===");
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
    xp: 120,
    flirtCount: 6,
  });
  const p1 = blocks.getUserProfile("p1")!;
  const block = pipe.profileBlock(p1);
  check("bond shown with Thai label and rank", block.includes("แอบชอบ") && block.includes("crush") && block.includes("ระดับ 3"), block);
  check("nicknames joined", block.includes("จิ้มจุ้ม, น้องยู"));
  check("facts rendered as bullets", block.includes("- [") && block.includes("ชอบชาเขียว"));
  check("fact timestamp converted to Thai time", block.includes("2026-08-31T03:01:47+07:00"), block);
  check("a fact with no timestamp has no bracket", block.includes("- ไม่มีเวลา"), block);
  check("xp present", block.includes("120"), block);
  check("retired stats are not shown to Gemini 1", !block.includes("trust") && !block.includes("affection") && !block.includes("familiarity"), block);
  check("flirt count is Gemini 2's business, not Gemini 1's", !block.includes("flirt"), block);
  check("she is told not to recite the numbers", block.includes("อย่านำไปพูดกับผู้ใช้"));
  check("profile with an empty name falls back to the caller's name", pipe.profileBlock({ ...p1, userName: "" }, "Fallback").includes("ชื่อ: Fallback"));

  const state = pipe.stateBlock(p1);
  check("state block has the rung", state.includes("bond: crush") && state.includes("ระดับ 3"), state);
  check("state block has xp and flirt count", state.includes("xp: 120") && state.includes("flirt_count: 6"), state);
  check("state block names the flirt requirement", state.includes("5"), state);
  check("state block lists what this rung must answer", state.includes("approveLover") && state.includes("isFlirt"), state);
  check("state block says the rung can still turn romantic", state.includes("พัฒนาเป็นเชิงชู้สาวได้"), state);
  check("state block wrapped", state.startsWith("<current_state>") && state.trimEnd().endsWith("</current_state>"));
  check("null state block still describes a stranger", pipe.stateBlock(null).includes("bond: stranger"), pipe.stateBlock(null));
  check("state block carries no facts (Gemini 2 does not need them)", !state.includes("ชอบชาเขียว"));
  check("enemy's state block drops the flirt requirement", pipe.stateBlock({ ...p1, bond: "enemy" }).includes("ไม่สามารถพัฒนาเป็นเชิงชู้สาว"), pipe.stateBlock({ ...p1, bond: "enemy" }));
  check("pending approvals are visible to Gemini 2", (() => {
    blocks.upsertUserProfile({ userId: "p2", userName: "P2", bond: "crush", xp: 100, approvals: { lover: true } });
    return pipe.stateBlock(blocks.getUserProfile("p2")).includes("approved_pending: lover");
  })(), pipe.stateBlock(blocks.getUserProfile("p2")));

  // The ladder rules used to be a `bondRulesBlock()` function here; they are a section of the prompt
  // file now, so they are asserted through the rendered instruction in section K2.
  const bands = bonds.xpBandsText();
  check("xp bands carry every xp-only rung", ["-150", "-149..149", "150..499", ">= 500"].every((n) => bands.includes(n)), bands);
  check("state block uses the shared band line", state.includes(`ขอบเขต xp: ${bands}`), state);
}

// ---------------------------------------------------------------- K2. the prompt template
console.log("=== K2. Gemini 2's instruction is a rendered file ===");
{
  const tpl = await import("../src/gemini/prompt-template.js");
  const cfg = (await import("../src/config.js")).config;
  const promptFile = join(PROJECT_ROOT, "src/gemini/prompts/isla-state.md");

  check("the instruction file exists", existsSync(promptFile));
  check("config points at it", cfg.paths.gemini2SystemPrompt === "./src/gemini/prompts/isla-state.md", cfg.paths.gemini2SystemPrompt);

  const rendered = pipe.gemini2SystemPrompt();
  const asks = tpl.promptPlaceholders(readFileSync(promptFile, "utf8"));
  check("the template asks for something", asks.length > 0, asks.join(","));
  check("every placeholder got a value", !rendered.includes("{{"), (rendered.match(/\{\{[^}]*\}\}/g) ?? []).join(","));
  check("nothing the template did not ask for is injected",
    asks.every((key) => key in pipe.gemini2PromptValues()),
    Object.keys(pipe.gemini2PromptValues()).filter((k) => !asks.includes(k)).join(","));
  check("the maintainer comment never reaches the model", !rendered.includes("<!--") && !rendered.includes("placeholders"), rendered.slice(0, 80));
  check("renders the same bytes twice (prompt cache)", pipe.gemini2SystemPrompt() === rendered);

  // --- the numbers come from the code, not from prose typed into the file ---
  const st = await import("../src/gemini/state-format.js");
  check("affinity range rendered", rendered.includes(`(${st.AFFINITY_MIN}..${st.AFFINITY_MAX})`), rendered.slice(0, 200));
  check("affinity floor rendered", rendered.includes(`อย่างน้อย +${st.AFFINITY_NEUTRAL_FLOOR}`));
  check("affinity bands match the schema's wording", rendered.includes(st.affinityScaleText()), st.affinityScaleText());
  check("the fact cap rendered", rendered.includes(`ไม่เกิน ${st.FACTS_PER_TURN} ข้อ`));
  check("the no-image answer is the constant", rendered.includes(`"${st.NO_IMAGE}"`), rendered.slice(0, 300));
  check("ladder lists every rung", bonds.BOND_NAMES.every((n: string) => rendered.includes(n)), bonds.BOND_NAMES.filter((n: string) => !rendered.includes(n)).join(","));
  check("ladder wrapped in <bond_levels>", rendered.includes("<bond_levels>") && rendered.includes("</bond_levels>"));
  check("ladder states the xp gates", rendered.includes("xp >= 500") && rendered.includes("xp <= -150"));
  check("flirt requirement rendered from bonds.ts", rendered.includes(`flirt_count >= ${bonds.FLIRT_REQUIREMENT}`));
  check("proposal xp rendered from bonds.ts", rendered.includes(`xp >= ${bonds.PROPOSAL_XP}`));
  check("instruction forbids naming a bond", rendered.includes("ห้ามเลือกระดับความสัมพันธ์เอง"));
  check("catalog is in the instruction", rendered.includes("<expression_images>") && rendered.includes(imageListForPrompt()));
  check("the retired tool vocabulary stayed retired", !rendered.includes("adjust_affection") && !rendered.includes("set_bond") && !rendered.includes("add_xp"));
  check("bondRulesBlock is gone", !("bondRulesBlock" in pipe));

  // --- relocatable, and re-read without a restart ---
  const custom = join(dir, "custom-state.md");
  writeFileSync(custom, "เทสต์เท่านั้น affinity {{affinity_floor}}\n<!-- note -->\n");
  const original = cfg.paths.gemini2SystemPrompt;
  cfg.paths.gemini2SystemPrompt = custom;
  check("GEMINI2_SYSTEM_PROMPT_FILE relocates the instruction", pipe.gemini2SystemPrompt() === "เทสต์เท่านั้น affinity 10", pipe.gemini2SystemPrompt());
  writeFileSync(custom, "ฉบับใหม่ {{proposal_xp}}\n");
  utimesSync(custom, new Date(), new Date(Date.now() + 2000));
  check("editing the file takes effect with no restart", pipe.gemini2SystemPrompt() === `ฉบับใหม่ ${bonds.PROPOSAL_XP}`, pipe.gemini2SystemPrompt());
  cfg.paths.gemini2SystemPrompt = original;
  check("restoring the path restores the instruction", pipe.gemini2SystemPrompt() === rendered);

  // --- the renderer itself ---
  check("renderPrompt fills numbers and strings", tpl.renderPrompt("a {{x}} b {{y}}", { x: 1, y: "สอง" }) === "a 1 b สอง");
  check("renderPrompt tolerates padded braces", tpl.renderPrompt("{{ x }}", { x: "v" }) === "v");
  check("renderPrompt leaves an unknown key literal", tpl.renderPrompt("{{x}}", {}) === "{{x}}");
  check("renderPrompt treats empty string as missing", tpl.renderPrompt("{{x}}", { x: "" }) === "{{x}}");
  check("renderPrompt strips comments", tpl.renderPrompt("keep<!-- drop -->{{x}}", { x: "!" }) === "keep!");
  check("promptPlaceholders ignores commented keys", tpl.promptPlaceholders("{{a}} <!-- {{b}} -->").join(",") === "a");
  check("loadPromptTemplate throws with the env var named", (() => {
    try {
      tpl.loadPromptTemplate(join(dir, "nowhere.md"), "GEMINI2_SYSTEM_PROMPT_FILE");
      return false;
    } catch (error) {
      return String(error).includes("GEMINI2_SYSTEM_PROMPT_FILE") && String(error).includes("file not found");
    }
  })());
  const kept = tpl.loadPromptTemplate(custom, "GEMINI2_SYSTEM_PROMPT_FILE");
  rmSync(custom);
  check("an unreadable file keeps the last good text", tpl.loadPromptTemplate(custom, "GEMINI2_SYSTEM_PROMPT_FILE", kept).text === kept.text);
}

// ---------------------------------------------------------------- L. applyState
console.log("=== L. applyState writes the JSON state ===");
{
  const s = (patch: Partial<import("../src/gemini/state-format.ts").IslaState>) => ({
    affinity: 10,
    selectImage: "",
    addFacts: [],
    addNicknames: [],
    ingestMemory: "",
    parsed: true,
    warnings: [],
    ...patch,
  });

  blocks.upsertUserProfile({ userId: "e1", userName: "Eunan", bond: "friend", xp: 100, facts: ["ของเดิม"] });
  check("affinity moves xp", (await pipe.applyState(s({ affinity: 20 }), "e1", "2026-03-03T00:00:00Z", "Eunan"), blocks.getUserProfile("e1")!.xp) === 120, blocks.getUserProfile("e1")!.xp);
  check("xp write never touches facts", blocks.getUserProfile("e1")!.facts[0].text === "ของเดิม");
  check("select_image returned", (await pipe.applyState(s({ selectImage: "happy.jpg" }), "e1", "t", "Eunan")).image === "happy.jpg");
  check("empty image means no image", (await pipe.applyState(s({}), "e1", "t", "Eunan")).image === undefined);
  check("the card carries the post-turn bond and xp", await (async () => {
    blocks.upsertUserProfile({ userId: "card1", userName: "Card", bond: "friend", xp: 120 });
    const applied = await pipe.applyState(s({ affinity: 30 }), "card1", "t", "Card");
    return applied.status.bond === "friend" && applied.status.xp === 150 && applied.status.xpDelta === 30
      && applied.status.userName === "Card";
  })(), true);
  check("the card carries the name and nicknames", await (async () => {
    blocks.upsertUserProfile({ userId: "e2", userName: "Farris", nickname: ["คนโปรด", "คนขี้แกล้ง"], bond: "lover", xp: 187 });
    const applied = await pipe.applyState(s({ affinity: 12 }), "e2", "t", "Farris");
    return applied.status.userName === "Farris"
      && applied.status.bond === "lover"
      && applied.status.xp === 199
      && applied.status.xpDelta === 12
      && (applied.status.nickname ?? []).join(",") === "คนโปรด,คนขี้แกล้ง";
  })(), true);
  check("a nickname from this turn is in the card", await (async () => {
    blocks.upsertUserProfile({ userId: "e3", userName: "Nico", bond: "friend", xp: 200 });
    const applied = await pipe.applyState(s({ addNicknames: ["คนเก่ง"] }), "e3", "t", "Nico");
    return (applied.status.nickname ?? []).join() === "คนเก่ง" && blocks.getUserProfile("e3")!.nickname.join() === "คนเก่ง";
  })(), true);
  check("duplicate nicknames are not re-added", await (async () => {
    await pipe.applyState(s({ addNicknames: ["คนเก่ง"] }), "e3", "t", "Nico");
    return blocks.getUserProfile("e3")!.nickname.length === 1;
  })(), true);
  check("a failed parse still returns a card with no change", await (async () => {
    const before = blocks.getUserProfile("e3")!;
    const applied = await pipe.applyState({ ...s({}), parsed: false, affinity: 0 }, "e3", "t", "Nico");
    return applied.status.xp === before.xp && applied.status.bond === before.bond && applied.image === undefined;
  })(), true);
  check("facts appended", (await pipe.applyState(s({ addFacts: ["ชอบกาแฟ", "ชอบชาเขียว"] }), "e1", "t", "Eunan"), blocks.getUserProfile("e1")!.facts.length) === 3, blocks.getUserProfile("e1")!.facts.map((f: { text: string }) => f.text));
  check("duplicate facts not re-added", (await pipe.applyState(s({ addFacts: ["ชอบกาแฟ"] }), "e1", "t", "Eunan"), blocks.getUserProfile("e1")!.facts.length) === 3);
  check("a flirt counts once per turn", (await pipe.applyState(s({ isFlirt: true }), "e1", "t", "Eunan"), blocks.getUserProfile("e1")!.flirtCount) === 1);
  check("is_flirt absent does not invent a flirt", (await pipe.applyState(s({}), "e1", "t", "Eunan"), blocks.getUserProfile("e1")!.flirtCount) === 1);
  check("an approval at the wrong rung is stored pending, not applied", (await pipe.applyState(s({ approveLover: true }), "e1", "t", "Eunan"), blocks.getUserProfile("e1")!.bond) === "friend");
  check("a state that failed to parse changes nothing", await (() => {
    const before = blocks.getUserProfile("e1")!;
    return pipe.applyState({ ...s({}), parsed: false, affinity: 0 }, "e1", "t", "Eunan").then(() => {
      const after = blocks.getUserProfile("e1")!;
      return after.xp === before.xp && after.bond === before.bond && after.flirtCount === before.flirtCount;
    });
  })(), true);
  check("a fresh user gets a row from applyState", (await pipe.applyState(s({ affinity: 10 }), "brand-new", "t", "New"), blocks.getUserProfile("brand-new")?.xp) === 10);
  check("the whole climb is reachable through applyState only", (() => {
    for (let i = 0; i < 5; i++) void pipe.applyState(s({ affinity: 100, isFlirt: true }), "climber", "t", "C");
    return true;
  })());
}

// ---------------------------------------------------------------- M. the wiring
console.log("=== M. the wiring and the retired paths ===");
{
  const src = readFileSync("src/pipeline/pipeline.ts", "utf8");
  const client = readFileSync("src/gemini/client.ts", "utf8");
  const profile = readFileSync("src/sql/profile.ts", "utf8");
  const prompt = readFileSync("src/gemini/prompts/isla.md", "utf8");

  check("Gemini 2 is given a JSON response_format", src.includes("schema: ISLA_STATE_SCHEMA"));
  check("Gemini 2 declares its stage explicitly", /stage: "gemini2"/.test(src));
  check("Gemini 2 no longer uses the tool path", !src.includes("EXECUTE_TOOL") && !src.includes('responseMode: "tool"'));
  // The instruction's wording is a prompt file now, so prose assertions read the file (and the
  // rendered result in K2), never pipeline.ts.
  const statePrompt = readFileSync("src/gemini/prompts/isla-state.md", "utf8");
  check("Gemini 2's instruction forbids setting a bond", statePrompt.includes("ห้ามเลือกระดับความสัมพันธ์เอง"));
  check("Gemini 2's instruction is no longer typed into pipeline.ts", !/วิเคราะห์บทสนทนา/.test(src));
  check("the instruction file carries no numbers of its own", !/[-+]?\b\d{2,}\b/.test(statePrompt.replace(/<!--[\s\S]*?-->/g, "")), (statePrompt.match(/[-+]?\b\d{2,}\b/g) ?? []).join(","));
  check("Gemini 2 sees Gemini 1's recap", src.includes("reply.summery") && src.includes("สรุปของข้อความนี้"));
  check("applyState replaced applyExecute", src.includes("export async function applyState") && !src.includes("export async function applyExecute"));
  check("no retired stat is read anywhere", !src.includes(".trust") && !src.includes(".affection") && !src.includes(".familiarity"));
  check("profile.ts no longer exports a bond setter for models", !profile.includes("export function setBond") && !profile.includes("export function adjustProfileStats"));
  check("profile.ts derives the bond", profile.includes("deriveBond("));
  check("client.ts picks keys by stage, not response mode", client.includes('options.stage ?? (mode === "tool" ? "gemini2" : "gemini1")'));
  check("thought signatures are harvested from both stages", /for \(const step of response\.steps \?\? \[\]\)/.test(client));
  check("the tool path is still available for Gemini 1's fake search_memory", client.includes("fakeToolCallResult"));
  check("Gemini 1's prompt teaches the proposal rule", prompt.includes("การขอสถานะความสัมพันธ์") && prompt.includes("ผลการขอ"));
  check("Gemini 1's prompt says the system computes the level", prompt.includes("ระดับความสัมพันธ์จริงถูกคำนวณโดยระบบ"));
  check("no romanticApproachCount/severeConflictCount came back", !src.includes("romanticApproachCount") && !src.includes("severeConflictCount"));
  check("the old two-table read is gone", !src.includes("getRelationships") && !existsSync("src/sql/relationship.ts"));
  check("the reply path never reads the relationships table", !/FROM relationships/.test(src));
  check("only the migration reads it, and only to fold it in", (profile.match(/FROM relationships/g) ?? []).length === 2);
  check("the profile block reaches Gemini 1's instruction", /systemInstruction: `\$\{systemPrompt\}\\n\\n\$\{identityBlock\}/.test(src));

  // --- the image catalog is the directory, not a copied list ---
  const images = readFileSync("src/bot/images.ts", "utf8");
  const state = readFileSync("src/gemini/state-format.ts", "utf8");
  check("the enum comes from the images directory", images.includes("readdirSync") && state.includes("imageNames(dir)") && state.includes("imageChoices()"));
  check("the schema enum is read live, so it cannot drift from the prompt list", /get enum\(\) \{\s*return imageChoices\(\);/.test(state));
  check("Gemini 2's instruction is a function so a new picture needs no restart", /export function gemini2SystemPrompt\(\): string/.test(src) && src.includes("systemInstruction: gemini2SystemPrompt()"));
  check("no invented image names survived", !/["'](neutral|shy_smile|soft_smile|playful|laugh)["']/.test(state));
  check("Gemini 2 is shown the catalog", src.includes("imageListForPrompt()") && statePrompt.includes("<expression_images>"));
  check("the catalog sits in the cached system prompt, not the per-turn message", src.indexOf("imageListForPrompt()") < src.indexOf("export function profileBlock"));
  // Quoted literals only: the module's doc comment names a real file as an example, and that is
  // documentation, not a list that can drift.
  check("images.ts no longer hardcodes a filename list", !/["']isla_[a-z_]+\.(jpg|png)["']/.test(images) && !images.includes("IMAGE_FILES"));
  check("fetching an image allowlists through the catalog", images.includes("isKnownImage(normalized"));

  // --- the footer is built from the turn's card, and the timestamp is not hardcoded ---
  const handler = readFileSync("src/bot/message-handler.ts", "utf8");
  const footer = readFileSync("src/bot/embed-footer.ts", "utf8");
  check("the flush hands the card to the payload", handler.includes("status: result.status"));
  check("the payload renders the footer through embed-footer", handler.includes("buildFooterText(") && handler.includes("setFooter({ text: buildFooterText"));
  check("the old single-line footer is gone", !handler.includes("ไอล่า ·"));
  check("setTimestamp is called with a value, not a literal date", /embed\.setTimestamp\(stamp\)/.test(handler) && !/new Date\("20\d\d/.test(handler));
  check("the timestamp defaults to now", handler.includes("options.timestamp === undefined ? new Date()"));
  check("the footer clips the name to 12", footer.includes("MAX_NAME_CHARS = 12"));
  check("the footer has the mood line", footer.includes("อารมณ์: "));
  check("an unknown bond renders no status", footer.includes("if (isBond(input.bond))"));
  check("the card is read after the nickname write", /const after = getUserProfile\(userId\)/.test(src));
  // The badges must be fed by the writer, never by the model's own claim.
  check("the card's flirt badge comes from the writer", /flirtDelta: result\.flirtDelta/.test(src));
  check("the card's unlock badge comes from the writer", /bondUnlocked: result\.bondUnlocked/.test(src));
  check("applyTurnState decides the unlock through the ladder rule", profile.includes("bondUnlocked: isBondUnlock(before, derivation.bond)"));
  check("the footer spells the badges exactly as the owner asked", footer.includes("[Flirt +") && footer.includes(" Unlocked]"));
}

rmSync(dir, { recursive: true, force: true });
console.log(fail ? `\n❌ ${fail} FAILED — ${pass} passed` : `\n✅ ALL PASS — ${pass} passed, 0 failed`);
process.exit(fail ? 1 : 0);
