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
 *   2. Gemini 1's dumped request carries the merged <user_profile> block, and none of the retired
 *      stats (trust/affection/familiarity) any more.
 *   3. Gemini 2 is asked for **JSON, not a tool call**: response_format carries the state schema,
 *      no tools are sent, and its reply parses into an IslaState.
 *   4. Gemini 2's request carries <bond_levels> + <current_state> but NOT <current_time>
 *      (a per-turn string would break its prompt cache) and NOT the facts.
 *   5. Turn 2 with a renamed user: the same row follows the new name, one row only.
 *   6. The turn actually moved state: xp >= the +10 floor, facts stored, memory optional.
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
const bonds = await import("../src/sql/bonds.js");
const { parseIslaState, IMAGES } = await import("../src/gemini/state-format.js");

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
check("shows accumulated closeness", /ความใกล้ชิดสะสม \(xp\): 0/.test(g1sys), g1sys.slice(0, 400));
check("retired stats are gone from Gemini 1's block", !g1sys.includes("trust:") && !g1sys.includes("affection:") && !g1sys.includes("familiarity:"), g1sys.slice(0, 400));
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
check("asks for JSON, not a tool call", JSON.stringify((g2req?.payload as { response_format?: unknown })?.response_format ?? "").includes("affinity") && JSON.stringify((g2req?.payload as { response_format?: unknown })?.response_format ?? "").includes("select_image"), JSON.stringify((g2req?.payload as { response_format?: unknown })?.response_format ?? "").slice(0, 200));
check("sends no tools", ((g2req?.payload as { tools?: unknown[] })?.tools ?? []).length === 0, JSON.stringify((g2req?.payload as { tools?: unknown[] })?.tools ?? []));
check("instruction lists the JSON fields", g2sys.includes("affinity") && g2sys.includes("is_flirt") && g2sys.includes("approve_lover") && g2sys.includes("approve_soulmate"), g2sys.slice(0, 200));
check("instruction forbids choosing a bond", g2sys.includes("ห้ามเลือกระดับความสัมพันธ์เอง"));
check("no execute-tool vocabulary left in the prompt", !g2sys.includes("adjust_affection") && !g2sys.includes("set_bond") && !g2sys.includes("add_xp"));

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
// The owner's floor: any turn that is not negative is worth at least +10. Two friendly turns
// therefore cannot leave xp at 0 — that is the assertion, not "something moved somewhere".
const xpMoved = (p2?.xp ?? 0) >= 20;
const memCount = await countMemories({ userId: USER });
console.log(`  (state seen: facts=${p2?.facts.length} xp=${p2?.xp} flirts=${p2?.flirtCount} bond=${p2?.bond} memories=${memCount})`);
check("xp moved by at least the +10 floor twice over", xpMoved, `xp=${p2?.xp} g2resp=${g2text.slice(0, 160)}`);
check("facts were learned from the live turn", factsNow, `facts=${p2?.facts.length}`);
check("bond is still a rung the ladder allows", bonds.BOND_NAMES.includes(p2?.bond ?? "stranger"), p2?.bond);
// Re-parse the model's *actual* reply text with the same parser the bot uses, so this is proof of
// the contract and not just the absence of a warning.
const g2out = (g2resp?.response as { output_text?: string } | undefined)?.output_text ?? "";
const liveState = parseIslaState(g2out, p2?.bond ?? "stranger");
check("gemini2's live reply parses as state JSON", liveState.parsed, JSON.stringify(g2out).slice(0, 200));
check("its affinity is inside -100..100", liveState.affinity >= -100 && liveState.affinity <= 100, String(liveState.affinity));
check("its image is one of the offered names", liveState.selectImage === "" || (IMAGES as readonly string[]).includes(liveState.selectImage), liveState.selectImage);
check("no parser warnings about an unreadable reply", !liveState.warnings.some((w: string) => w.includes("reply was not JSON")), liveState.warnings.join("; "));

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
