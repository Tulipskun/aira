// Regression test: every debug record for one Gemini turn should share its correlation id.
import { debugDump, readDebugDump } from "../src/gemini/debug-dump.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "aira-debug-correlation-test-"));
const file = join(dir, "payload.json");
process.env.GEMINI_DEBUG_PAYLOAD = "1";
process.env.GEMINI_DEBUG_PAYLOAD_FILE = file;

debugDump({ ts: "t1", stage: "gemini1", event: "request", model: "m", turnId: "turn-123" });
debugDump({ ts: "t2", stage: "gemini1", event: "response", model: "m", turnId: "turn-123" });
debugDump({ ts: "t3", stage: "gemini2", event: "request", model: "m2", turnId: "turn-123" });

const records = readDebugDump(file);
const ok = records.length === 3 && records.every((record) => record.turnId === "turn-123");
console.log(`${ok ? "PASS" : "FAIL"}: Gemini debug records carry the same turn id`);
rmSync(dir, { recursive: true, force: true });
if (!ok) process.exit(1);
