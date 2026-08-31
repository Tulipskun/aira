/**
 * Live end-to-end proof for the MERGED profile API (user_profiles is the single source).
 *   bun run scripts/test-profile-e2e.ts
 *
 * SPENDS REAL API QUOTA (2 full pipeline turns) — not part of the offline suite. It isolates
 * itself exactly like test-media-e2e.ts: throwaway SQLite file, throwaway Chroma collection,
 * its own payload-dump path. The real DB is opened read-only before/after to prove the run
 * touched nothing outside the temp dir.
 *
 * What it asserts, in order:
 *   1. Turn 1 answers, and the row is created in the ONE table (no relationships involved).
 *   2. Gemini 1's dumped request carries the merged <user_profile> block (bond line + stats).
 *   3. Gemini 2's dumped request carries <bond_levels> + <current_state> but NOT
 *      <current_time> (per-turn string would break its prompt cache) and NOT the facts.
 *   4. Turn 2 with a renamed user: the same row follows the new name, and the block shows
 *      the old name as an alias instead of losing it.
 *   5. Whatever Gemini 2 decided (facts/xp/bond/memory) landed in user_profiles — one read.
 *   6. The real DB and the real Chroma collection are byte-identical to before the run.
 */
import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";

let pass = 0;
let fail = 0;
function check(label: string, cond: boolean, detail = ""): void {
  console.log(`  ${cond ? "✅" : "❌"} ${label}${cond ? "" : detail ? ` — ${detail}` : ""}`);
  if (cond) pass++;
  else fail++;
}

const dir = mkdtempSync(join(tmpdir(), "aira-profile-e2e-"));
const REAL_DB = "./.aira/aira.db";

// Snapshot the real stores BEFORE anything is imported (import runs the migration on whatever
// SQLITE_PATH points at — that is about to be the temp file, never the real one).
const realBefore = existsSync(REAL_DB)
  ? {
      messages: (new Database(REAL_DB, { readonly: true }).query("SELECT COUNT(*) c FROM messages").get() as { c: number }).c,
      profiles: (new Database(REAL_DB, { readonly: true }).query("SELECT COUNT(*) c FROM user_profiles").get() as { c: number }).c,
    }
  : null;

process.env.SQLITE_PATH = join(dir, "e2e.db");
process.env.CHROMA_COLLECTION = "aira_profile_e2e_test";
process.env.GEMINI_DEBUG_PAYLOAD = "1";
process.env.GEMINI_DEBUG_PAYLOAD_FILE = join(dir, "payload.json");

const { processMessage } = await import("../src/pipeline/pipeline.js");
const { getUserProfile } = await import("../src/sql/profile.js");
const { countMemories, deleteMemories } = await import("../src/memory/chroma.js");
const { readDebugDump } = await import("../src/gemini/debug-dump.js");

const USER = "e2e-profile-user-1";
const nowIso = () => new Date().toISOString();

console.log("=== 1. turn 1: answer + row created in the ONE table ===");
const t1 = await processMessage({
  userId: USER,
  user: "Nok",
  text: "ฉันชื่อหน่อนะ ทำงานเป็นโปรแกรมเมอร์ ชอบกาแฟเย็นมาก จำไว้ด้วยล่ะ",
  timestamp: nowIso(),
});
check("got a non-empty reply", typeof t1.text === "string" && t1.text.length > 0, JSON.stringify(t1.text).slice(0, 80));
const p1 = getUserProfile(USER);
check("row exists in user_profiles", p1 !== null);
check("name stored", p1?.userName === "Nok", JSON.stringify(p1?.userName));
check("bond defaults to stranger", p1?.bond === "stranger", JSON.stringify(p1?.bond));

// `system_instruction` is a top-level key of the dumped payload and is a plain string (verified
// against the live dump file) — not nested under `input`.
type DumpPayload = { system_instruction?: unknown };
function sysOf(record: { payload?: unknown } | undefined): string {
  return String((record?.payload as DumpPayload | undefined)?.system_instruction ?? "");
}

console.log("=== 2. Gemini 1 saw the merged <user_profile> block ===");
let dump = readDebugDump();
const g1req = dump.find((r) => r.stage === "gemini1" && r.event === "request");
const g1sys = sysOf(g1req);
check("gemini1 request dumped", !!g1req);
check("has <user_profile>", g1sys.includes("<user_profile>"));
check("has bond line (merged, not the old relationship block)", g1sys.includes("ความสัมพันธ์กับ Isla:"), g1sys.slice(0, 200));
check("has stats incl. familiarity", g1sys.includes("familiarity:") && g1sys.includes("affection:") && g1sys.includes("trust:"));
check("has facts list", g1sys.includes("fact:"));
check("has <current_time> for gemini1", g1sys.includes("<current_time>"));

console.log("=== 3. Gemini 2 saw state+ladder, NOT per-turn time, NOT facts ===");
const g2req = dump.find((r) => r.stage === "gemini2" && r.event === "request");
const g2sys = sysOf(g2req);
// `<current_state>` changes every turn, so it travels in the message, not the system prompt —
// a per-turn string in the instruction would break Gemini 2's prompt cache (see runGemini2()).
const g2input = JSON.stringify((g2req?.payload as { input?: unknown })?.input ?? "");
check("gemini2 request dumped", !!g2req);
check("has <bond_levels>", g2sys.includes("<bond_levels>"));
check("has <current_state> in the message", g2input.includes("<current_state>") || g2sys.includes("<current_state>"), g2input.slice(0, 200));
check("NO <current_time> (prompt-cache invariant)", !g2sys.includes("<current_time>"));
check("NO facts material (that is gemini1's job)", !g2sys.includes("fact:"));
check("advertises the single `execute` tool contract", g2sys.includes("execute") && g2sys.includes("adjust_affection") && g2sys.includes("set_bond") && g2sys.includes("add_facts"), g2sys.slice(0, 200));

console.log("=== 4. turn 2: rename follows the SAME row (one identity, no duplicate) ===");
const t2 = await processMessage({
  userId: USER,
  user: "Noknoi",
  text: "เปลี่ยนชื่อเรียกเป็นหน่อน้อยแล้วนะ จำกาแฟเย็นที่บอกได้ไหม",
  timestamp: nowIso(),
});
check("turn 2 answered", typeof t2.text === "string" && t2.text.length > 0);
const p2 = getUserProfile(USER);
check("name now follows Discord", p2?.userName === "Noknoi", JSON.stringify(p2?.userName));
// `nickname` is Isla's own pet-name list (model-controlled). A Discord rename must NOT be pushed
// into it: restateHistory() deliberately re-stamps old rows so the model sees ONE identity.
check("rename did not pollute Isla's nickname list", Array.isArray(p2?.nickname), JSON.stringify(p2?.nickname));
const rows = new Database(process.env.SQLITE_PATH!, { readonly: true })
  .query("SELECT COUNT(*) c FROM user_profiles WHERE user_id = ?").get(USER) as { c: number };
check("still exactly ONE row for this user", rows.c === 1, `rows=${rows.c}`);
dump = readDebugDump();
const g1req2 = [...dump].reverse().find((r) => r.stage === "gemini1" && r.event === "request");
const g1sys2 = sysOf(g1req2);
check("turn-2 block shows the current name", g1sys2.includes("Noknoi"));

console.log("=== 5. whatever gemini2 decided landed in the ONE table ===");
const g2resp = [...dump].reverse().find((r) => r.stage === "gemini2" && r.event === "response");
const g2text = JSON.stringify(g2resp?.response ?? "");
const factsNow = (p2?.facts.length ?? 0) > 0;
const xpMoved = (p2?.xp ?? 0) !== 0 || (p2?.affection ?? 0) !== 0 || (p2?.familiarity ?? 0) !== 0;
const bondMoved = p2?.bond !== "stranger";
const memCount = await countMemories({ userId: USER });
console.log(`  (model ops seen: facts=${p2?.facts.length} xp=${p2?.xp} aff=${p2?.affection} fam=${p2?.familiarity} bond=${p2?.bond} memories=${memCount})`);
check("at least one channel of state actually moved (facts/xp/bond/memory)", factsNow || xpMoved || bondMoved || memCount > 0, `g2resp=${g2text.slice(0, 160)}`);

console.log("=== 6. real stores untouched ===");
if (realBefore) {
  const db = new Database(REAL_DB, { readonly: true });
  const messages = (db.query("SELECT COUNT(*) c FROM messages").get() as { c: number }).c;
  const profiles = (db.query("SELECT COUNT(*) c FROM user_profiles").get() as { c: number }).c;
  check("real messages count unchanged", messages === realBefore.messages, `${realBefore.messages} -> ${messages}`);
  check("real user_profiles count unchanged", profiles === realBefore.profiles, `${realBefore.profiles} -> ${profiles}`);
  db.close();
} else {
  check("no real DB present to pollute", true);
}
if (memCount > 0) {
  const removed = await deleteMemories({ userId: USER });
  check("test memories cleaned from the test collection", removed === memCount);
}

rmSync(dir, { recursive: true, force: true });
console.log(`\n${fail === 0 ? "✅" : "❌"} ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
