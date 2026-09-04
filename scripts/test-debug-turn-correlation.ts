// Regression test: Gemini 1 + Gemini 2 records for one turn should share an automatic id.
import { debugDump, readDebugDump } from "../src/gemini/debug-dump.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "aira-debug-correlation-test-"));
const file = join(dir, "payload.json");
process.env.GEMINI_DEBUG_PAYLOAD = "1";
process.env.GEMINI_DEBUG_PAYLOAD_FILE = file;

debugDump({ ts: "t1", stage: "gemini1", event: "request", model: "m", attempt: 1, userId: "u1", userName: "Tester" });
debugDump({ ts: "t2", stage: "gemini1", event: "response", model: "m", attempt: 1, userId: "u1", userName: "Tester" });
debugDump({ ts: "t3", stage: "gemini2", event: "request", model: "m2", attempt: 1, userId: "u1", userName: "Tester" });
debugDump({ ts: "t4", stage: "gemini2", event: "response", model: "m2", attempt: 1, userId: "u1", userName: "Tester" });

const records = readDebugDump(file);
const ids = new Set(records.map((record) => record.turnId));
const ok = records.length === 4 && ids.size === 1 && !!records[0]?.turnId;
console.log(`${ok ? "PASS" : "FAIL"}: Gemini 1 and Gemini 2 records share one automatic turn id`);
rmSync(dir, { recursive: true, force: true });
if (!ok) process.exit(1);
