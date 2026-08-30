// Verification for the debug payload dumper. No network, no Discord: sendRequestGemini is called
// with a bogus key so the request fails fast, and the dump file is asserted directly.
//   GEMINI_DEBUG_PAYLOAD=1 bun run scripts/test-debug-dump.ts
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let pass = 0;
let fail = 0;
function check(label: string, cond: boolean): void {
  console.log(`  ${cond ? "✅" : "❌"} ${label}`);
  cond ? pass++ : fail++;
}

const dir = mkdtempSync(join(tmpdir(), "aira-dump-test-"));
const dumpFile = join(dir, "payload.jsonl");
process.env.GEMINI_DEBUG_PAYLOAD_FILE = dumpFile;
// Bun auto-loads .env, whose GEMINI1_API_KEYS/GEMINI2_API_KEYS pool is exactly what
// sendRequestGemini rotates over -- the explicit key only matters when the pool is empty. So the
// pool vars MUST be overridden here, or this test silently spends real quota. (GoogleGenAI itself
// always prefers the apiKey passed to its constructor over GOOGLE_API_KEY/GEMINI_API_KEY from the
// env; deleting it here just silences a misleading SDK warning.)
const savedGoogleKey = process.env.GOOGLE_API_KEY;
delete process.env.GOOGLE_API_KEY;
process.env.GEMINI_API_KEY = "test-key-not-real";
process.env.GEMINI1_API_KEYS = "test-key-1-not-real";
process.env.GEMINI2_API_KEYS = "test-key-2-not-real";

const { debugDumpEnabled, debugDump, readDebugDump, migrateDebugDumpFile } = await import("../src/gemini/debug-dump.js");
const { sendRequestGemini, fakeToolCallResult, ctxWindowCreate } = await import("../src/gemini/client.js");

// Records are typed loosely here on purpose: the test pokes at arbitrary payload shapes, and the
// file is a debug artifact whose schema is whatever client.ts happened to send.
const dump = (): any[] => readDebugDump(dumpFile);

console.log("=== 1. toggle reads env live, off by default ===");
delete process.env.GEMINI_DEBUG_PAYLOAD;
check("unset -> disabled", debugDumpEnabled() === false);
process.env.GEMINI_DEBUG_PAYLOAD = "0";
check("0 -> disabled", debugDumpEnabled() === false);
process.env.GEMINI_DEBUG_PAYLOAD = "false";
check("false -> disabled", debugDumpEnabled() === false);
process.env.GEMINI_DEBUG_PAYLOAD = "";
check("empty -> disabled", debugDumpEnabled() === false);
for (const value of ["1", "true", "TRUE", " yes ", "on"]) {
  process.env.GEMINI_DEBUG_PAYLOAD = value;
  check(`${JSON.stringify(value)} -> enabled`, debugDumpEnabled() === true);
}

console.log("=== 2. disabled writes nothing ===");
process.env.GEMINI_DEBUG_PAYLOAD = "0";
debugDump({ ts: "x", stage: "gemini1", event: "request", model: "m", payload: { secret: true } });
check("no file created while off", !existsSync(dumpFile));

console.log("=== 3. enabled writes a whole-file-parseable JSON array ===");
process.env.GEMINI_DEBUG_PAYLOAD = "1";
debugDump({ ts: "2026-01-01T00:00:00.000Z", stage: "gemini1", event: "request", model: "m1", attempt: 1, payload: { a: 1 } });
debugDump({ ts: "2026-01-01T00:00:01.000Z", stage: "gemini2", event: "response", model: "m2", response: { output_text: "hi" } });
// The whole point of the array format: one JSON.parse over the entire file.
const wholeFile = readFileSync(dumpFile, "utf8");
const parsedWhole = JSON.parse(wholeFile);
check("whole file parses as JSON", Array.isArray(parsedWhole));
check("both records present", parsedWhole.length === 2);
check("no trailing comma before the closing bracket", /\}\n\]\n$/.test(wholeFile));
check("file starts with '['", wholeFile.startsWith("["));
check("file ends with ']'", wholeFile.trimEnd().endsWith("]"));
check("records stay one-per-line for grep/tail", wholeFile.split("\n").length === 5);
check("line 1 is the gemini1 request", parsedWhole[0].stage === "gemini1" && parsedWhole[0].event === "request" && parsedWhole[0].payload.a === 1);
check("line 2 is the gemini2 response", parsedWhole[1].stage === "gemini2");
check("readDebugDump agrees with JSON.parse", dump().length === 2);

console.log("=== 3b. every intermediate state is valid JSON (valid while the bot runs) ===");
for (let i = 0; i < 5; i++) {
  debugDump({ ts: `t${i}`, stage: "gemini1", event: "request", model: "m" });
  let valid = true;
  try {
    JSON.parse(readFileSync(dumpFile, "utf8"));
  } catch {
    valid = false;
  }
  check(`valid after record ${i + 3}`, valid);
}
check("record count grew to 7", JSON.parse(readFileSync(dumpFile, "utf8")).length === 7);

console.log("=== 3c. legacy JSONL file is migrated without losing records ===");
const legacyFile = join(dir, "legacy.jsonl");
// A signature that was already shortened by an older build. Migration must NOT re-redact it:
// running redact() twice turns "…(128)" into "…(18)" and silently corrupts the dump.
const alreadyShortened = "El4KXAERTTIP…(128)";
writeFileSync(legacyFile, `${JSON.stringify({ ts: "a", stage: "gemini1", event: "request", model: "m", payload: { input: [{ type: "thought", signature: alreadyShortened }] } })}\n${JSON.stringify({ ts: "b", stage: "gemini2", event: "response", model: "m" })}\n`);
let legacyBroke = false;
try {
  JSON.parse(readFileSync(legacyFile, "utf8"));
} catch {
  legacyBroke = true;
}
check("legacy JSONL does not parse as one JSON value (the reported bug)", legacyBroke);
process.env.GEMINI_DEBUG_PAYLOAD_FILE = legacyFile;
debugDump({ ts: "c", stage: "gemini1", event: "request", model: "m" });
const migrated = JSON.parse(readFileSync(legacyFile, "utf8"));
check("migrated to a JSON array", Array.isArray(migrated) && migrated.length === 3);
check("old records preserved in order", migrated[0].ts === "a" && migrated[1].ts === "b" && migrated[2].ts === "c");
check("migration does not re-redact an already-shortened signature", migrated[0].payload.input[0].signature === alreadyShortened);
process.env.GEMINI_DEBUG_PAYLOAD_FILE = dumpFile;

console.log("=== 3e. migrateDebugDumpFile is idempotent and byte-preserving ===");
const migFile = join(dir, "mig.jsonl");
const legacyRecords = [
  { ts: "1", stage: "gemini1", event: "request", model: "m", payload: { input: [{ type: "thought", signature: "abc…(128)" }], apiKey: "[redacted]" } },
  { ts: "2", stage: "gemini2", event: "response", model: "m", response: { output_text: "ไทย", steps: [{ signature: "xyz…(64)" }] } },
];
writeFileSync(migFile, legacyRecords.map((r) => JSON.stringify(r)).join("\n") + "\n");
const first = migrateDebugDumpFile(migFile);
check("reports 2 records migrated", first.records === 2 && first.changed === true);
check("records survive byte-identically", JSON.stringify(readDebugDump(migFile)) === JSON.stringify(legacyRecords));
const second = migrateDebugDumpFile(migFile);
check("second run changes nothing (idempotent)", second.changed === false && second.records === 2);
check("file parses as one array", JSON.parse(readFileSync(migFile, "utf8")).length === 2);
process.env.GEMINI_DEBUG_PAYLOAD_FILE = dumpFile;

console.log("=== 3d. unreadable file is moved aside, not silently overwritten ===");
const junkFile = join(dir, "junk.jsonl");
writeFileSync(junkFile, "not json at all\n}}}\n");
process.env.GEMINI_DEBUG_PAYLOAD_FILE = junkFile;
debugDump({ ts: "z", stage: "gemini1", event: "request", model: "m" });
check("fresh array started", JSON.parse(readFileSync(junkFile, "utf8")).length === 1);
check("original bytes kept in .bak", readFileSync(`${junkFile}.bak`, "utf8").includes("not json at all"));
process.env.GEMINI_DEBUG_PAYLOAD_FILE = dumpFile;

console.log("=== 3f. truncated file (killed mid-write) recovers intact records ===");
const truncFile = join(dir, "trunc.jsonl");
const good = [
  { ts: "g1", stage: "gemini1", event: "request", model: "m" },
  { ts: "g2", stage: "gemini2", event: "response", model: "m" },
  { ts: "g3", stage: "gemini1", event: "request", model: "m" },
];
// Simulate a crash after the third record's opening brace: no closing ']', torn tail.
writeFileSync(truncFile, `[\n${JSON.stringify(good[0])},\n${JSON.stringify(good[1])},\n{"ts":"g3","st`);
let truncBroke = false;
try {
  JSON.parse(readFileSync(truncFile, "utf8"));
} catch {
  truncBroke = true;
}
check("truncated file is not parseable as-is", truncBroke);
process.env.GEMINI_DEBUG_PAYLOAD_FILE = truncFile;
debugDump({ ts: "g4", stage: "gemini1", event: "request", model: "m" });
const recovered = JSON.parse(readFileSync(truncFile, "utf8"));
check("recovered as a valid array again", Array.isArray(recovered));
check("the two intact records survived", recovered[0].ts === "g1" && recovered[1].ts === "g2");
check("new record appended after recovery", recovered.at(-1).ts === "g4");
check("only the torn tail was dropped", recovered.length === 3);
process.env.GEMINI_DEBUG_PAYLOAD_FILE = dumpFile;

console.log("=== 3g. truncated file with intact tail keeps every record ===");
const trunc2 = join(dir, "trunc2.jsonl");
writeFileSync(trunc2, `[\n${JSON.stringify(good[0])},\n${JSON.stringify(good[1])}\n`);
process.env.GEMINI_DEBUG_PAYLOAD_FILE = trunc2;
debugDump({ ts: "x", stage: "gemini1", event: "request", model: "m" });
const rec2 = JSON.parse(readFileSync(trunc2, "utf8"));
check("all 3 records present (nothing dropped)", rec2.length === 3 && rec2[0].ts === "g1" && rec2[1].ts === "g2" && rec2[2].ts === "x");
process.env.GEMINI_DEBUG_PAYLOAD_FILE = dumpFile;

console.log("=== 4. redaction ===");
debugDump({ ts: "t", stage: "gemini1", event: "request", model: "m", payload: { apiKey: "super-secret", token: "abc", input: [{ type: "thought", signature: "S".repeat(128) }] } });
const red = dump().at(-1);
check("apiKey redacted", red.payload.apiKey === "[redacted]");
check("token redacted", red.payload.token === "[redacted]");
check("signature shortened, not full", typeof red.payload.input[0].signature === "string" && red.payload.input[0].signature.length < 30 && red.payload.input[0].signature.includes("(128)"));
check("raw secret never hits the file", !readFileSync(dumpFile, "utf8").includes("super-secret"));

console.log("=== 5. sendRequestGemini dumps request + error for both stages ===");
process.env.GEMINI_DEBUG_PAYLOAD = "1";
const before = dump().length;
const req = ctxWindowCreate([{ role: "user", user: "Tester", text: "hello", timestamp: "t0" }], "hello", "Tester", "t1", undefined, fakeToolCallResult("search_memory", { user: "Tester" }, { memories: [] }), "u1");
for (const mode of ["text", "tool"] as const) {
  let threw = false;
  try {
    await sendRequestGemini(req, { responseMode: mode, systemInstruction: "test system prompt", debug: { userId: "u1", userName: "Tester" } });
  } catch {
    threw = true;
  }
  check(`${mode}: request failed as expected with a bogus key`, threw);
}
const records = dump().slice(before);
check("file still parses as one array after real traffic", Array.isArray(JSON.parse(readFileSync(dumpFile, "utf8"))));
const g1 = records.filter((r) => r.stage === "gemini1");
const g2 = records.filter((r) => r.stage === "gemini2");
check("gemini1 records written", g1.length >= 2);
check("gemini2 records written", g2.length >= 2);
check("gemini1 has request + error", g1.some((r) => r.event === "request") && g1.some((r) => r.event === "error"));
check("gemini2 has request + error", g2.some((r) => r.event === "request") && g2.some((r) => r.event === "error"));
check("request payload carries the synthetic tool steps", g1.find((r) => r.event === "request").payload.input.some((s: { type: string }) => s.type === "function_call"));
check("request payload carries system_instruction for gemini2", g2.find((r) => r.event === "request").payload.system_instruction !== undefined);
check("gemini2 request carries generation_config tool_choice", g2.find((r) => r.event === "request").payload.generation_config?.tool_choice?.allowed_tools?.mode === "any");
check("identity attached to every record", records.every((r) => r.userId === "u1" && r.userName === "Tester"));
check("error record has status/message", g1.find((r) => r.event === "error").error.message.length > 0);
check("no API key leaked into the dump", !readFileSync(dumpFile, "utf8").includes("test-key-not-real"));
console.log("=== 6. key rotation uses the configured pool, never the ambient env key ===");
// Guards the exact misreading this test's author fell for: if sendRequestGemini ever fell back to
// GOOGLE_API_KEY from the environment, rotation would be silently bypassed in production.
if (savedGoogleKey) {
  process.env.GOOGLE_API_KEY = savedGoogleKey; // real ambient key, present on this host
  process.env.GEMINI1_API_KEYS = "pool-key-1-not-real,pool-key-2-not-real";
  process.env.GEMINI2_API_KEYS = "pool-key-3-not-real";
  let ambientUsed = false;
  for (const mode of ["text", "tool"] as const) {
    try {
      await sendRequestGemini(req, { responseMode: mode, systemInstruction: "test" });
      ambientUsed = true; // succeeded => it authenticated with a key that is not in the pool
    } catch {
      /* expected: pool keys are bogus */
    }
  }
  check("bogus pool wins over ambient GOOGLE_API_KEY (rotation intact)", !ambientUsed);
  delete process.env.GOOGLE_API_KEY;
} else {
  console.log("  ⏭  skipped — no ambient GOOGLE_API_KEY on this host");
}

console.log("=== 7. unwritable path does not throw ===");
process.env.GEMINI_DEBUG_PAYLOAD_FILE = "/proc/nonexistent-dir/payload.jsonl";
let threwOnBadPath = false;
try {
  debugDump({ ts: "t", stage: "gemini1", event: "request", model: "m" });
} catch {
  threwOnBadPath = true;
}
check("debugDump swallows write errors", !threwOnBadPath);

rmSync(dir, { recursive: true, force: true });
if (savedGoogleKey) process.env.GOOGLE_API_KEY = savedGoogleKey;
console.log(`\n${fail === 0 ? "✅ ALL PASS" : "❌ FAILURES"} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
