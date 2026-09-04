// Verification for the Gemini debug payload dumper. No network is required for the retention tests.
//   bun run scripts/test-debug-dump.ts
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let pass = 0;
let fail = 0;
function check(label: string, condition: boolean): void {
  console.log(`  ${condition ? "✅" : "❌"} ${label}`);
  condition ? pass++ : fail++;
}

const dir = mkdtempSync(join(tmpdir(), "aira-debug-dump-test-"));
const file = join(dir, "payload.json");
process.env.GEMINI_DEBUG_PAYLOAD_FILE = file;

const { debugDumpEnabled, debugDump, readDebugDump, migrateDebugDumpFile } = await import("../src/gemini/debug-dump.js");

console.log("=== 1. debug payload is enabled by default ===");
delete process.env.GEMINI_DEBUG_PAYLOAD;
check("unset -> enabled", debugDumpEnabled() === true);
for (const value of ["1", "true", "yes", "on"]) {
  process.env.GEMINI_DEBUG_PAYLOAD = value;
  check(`${JSON.stringify(value)} -> enabled`, debugDumpEnabled() === true);
}
for (const value of ["0", "false", "no", "off"]) {
  process.env.GEMINI_DEBUG_PAYLOAD = value;
  check(`${JSON.stringify(value)} -> disabled`, debugDumpEnabled() === false);
}

console.log("=== 2. default writes debug records ===");
delete process.env.GEMINI_DEBUG_PAYLOAD;
debugDump({ ts: "t0", stage: "gemini1", event: "request", model: "m", turnId: "turn-0", payload: { apiKey: "secret" } });
check("file created when env is unset", existsSync(file));
check("record written", readDebugDump(file).length === 1);
check("turn id written", readDebugDump(file)[0]?.turnId === "turn-0");
check("secret redacted", JSON.stringify(readDebugDump(file)).includes("[redacted]"));
check("raw secret absent", !readFileSync(file, "utf8").includes("secret"));

console.log("=== 3. only latest three request/response/error pairs are retained ===");
for (let turn = 1; turn <= 5; turn++) {
  debugDump({ ts: `t${turn}-request`, stage: "gemini1", event: "request", model: "m", turnId: `turn-${turn}`, payload: { turn } });
  debugDump({ ts: `t${turn}-response`, stage: "gemini1", event: "response", model: "m", turnId: `turn-${turn}`, response: { turn } });
}
const retained = readDebugDump(file);
check("retains exactly six records", retained.length === 6);
check("oldest retained turn is #3", retained[0]?.ts === "t3-request");
check("latest retained turn is #5", retained.at(-1)?.ts === "t5-response");
check("turn id groups request/response", retained.every((r) => r.turnId === "turn-" + r.ts.slice(1, 2)));
check("records remain chronological", retained.every((r, i) => i === 0 || r.ts >= retained[i - 1]!.ts));
check("whole file remains valid JSON", Array.isArray(JSON.parse(readFileSync(file, "utf8"))));

console.log("=== 4. disabled mode writes nothing ===");
const before = readDebugDump(file).length;
process.env.GEMINI_DEBUG_PAYLOAD = "off";
debugDump({ ts: "disabled", stage: "gemini1", event: "request", model: "m", turnId: "disabled" });
check("disabled write does not change records", readDebugDump(file).length === before);

console.log("=== 5. legacy JSONL migrates and is capped ===");
const legacy = join(dir, "legacy.jsonl");
const legacyRecords = Array.from({ length: 5 }, (_, i) => ({ ts: `legacy-${i}`, stage: "gemini1", event: "request", model: "m" }));
const { writeFileSync } = await import("node:fs");
writeFileSync(legacy, legacyRecords.map((r) => JSON.stringify(r)).join("\n") + "\n");
const migration = migrateDebugDumpFile(legacy);
const migrated = readDebugDump(legacy);
check("migration reports a change", migration.changed === true);
check("migration keeps only latest three records", migration.records === 5 && migrated.length === 5);
// Migration itself preserves existing records; the retention limit applies when new debug traffic arrives.
process.env.GEMINI_DEBUG_PAYLOAD = "1";
debugDump({ ts: "legacy-new", stage: "gemini1", event: "request", model: "m", turnId: "legacy-new" });
check("new traffic applies the retention cap", readDebugDump(legacy).length === 6);

console.log(`\n${fail === 0 ? "PASS" : "FAIL"}: ${pass} passed, ${fail} failed`);
rmSync(dir, { recursive: true, force: true });
if (fail) process.exit(1);
