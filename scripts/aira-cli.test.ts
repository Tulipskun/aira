import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCommand, readStatus, tailLog } from "./aira-cli.js";

assert.deepEqual(buildCommand([]), { command: "help" });
assert.deepEqual(buildCommand(["start"]), { command: "start" });
assert.deepEqual(buildCommand(["log"]), { command: "log" });
assert.deepEqual(buildCommand(["logs"]), { command: "log" });
assert.deepEqual(buildCommand(["restart"]), { command: "restart" });
assert.deepEqual(buildCommand(["status"]), { command: "status" });

const root = mkdtempSync(join(tmpdir(), "aira-cli-"));
const runtime = join(root, ".aira");
const logDir = join(runtime, "logs");
mkdirSync(logDir, { recursive: true });
writeFileSync(join(logDir, "aira.log"), "one\ntwo\nthree\nfour\n");
assert.equal(tailLog(join(logDir, "aira.log"), 2), "three\nfour");

writeFileSync(join(runtime, "supervisor.pid"), "12345\n");
const status = readStatus(root);
assert.equal(status.pid, 12345);
assert.equal(status.running, false);

console.log("aira-cli tests: OK");
