import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCommand, hasRevisionChanged, readStatus, tailLog, runUpdate } from "./aira-cli.js";

assert.deepEqual(buildCommand([]), { command: "help" });
assert.deepEqual(buildCommand(["start"]), { command: "start" });
assert.deepEqual(buildCommand(["log"]), { command: "log" });
assert.deepEqual(buildCommand(["logs"]), { command: "log" });
assert.deepEqual(buildCommand(["restart"]), { command: "restart" });
assert.deepEqual(buildCommand(["status"]), { command: "status" });
assert.deepEqual(buildCommand(["register_commands"]), { command: "register_commands" });
assert.deepEqual(buildCommand(["update"]), { command: "update" });
assert.equal(hasRevisionChanged("abc", "abc"), false);
assert.equal(hasRevisionChanged("abc", "def"), true);

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

const calls = { register: 0, stop: 0, start: 0 };
const unchangedCode = await runUpdate(root, {
  gitPull: () => ({ code: 0, before: "same", after: "same" }),
  isRunning: () => false,
  stop: () => { calls.stop += 1; return 0; },
  registerCommands: () => { calls.register += 1; return 0; },
  start: () => { calls.start += 1; return 0; },
});
assert.equal(unchangedCode, 0);
assert.deepEqual(calls, { register: 0, stop: 0, start: 0 });

calls.stop = 0;
calls.start = 0;
const changedCode = await runUpdate(root, {
  gitPull: () => ({ code: 0, before: "old", after: "new" }),
  isRunning: () => true,
  stop: () => { calls.stop += 1; return 0; },
  registerCommands: () => { calls.register += 1; return 0; },
  start: () => { calls.start += 1; return 0; },
});
assert.equal(changedCode, 0);
assert.deepEqual(calls, { register: 1, stop: 1, start: 1 });

calls.stop = 0;
calls.start = 0;
const stoppedCode = await runUpdate(root, {
  gitPull: () => ({ code: 0, before: "old", after: "new" }),
  isRunning: () => false,
  stop: () => { calls.stop += 1; return 0; },
  registerCommands: () => { calls.register += 1; return 0; },
  start: () => { calls.start += 1; return 0; },
});
assert.equal(stoppedCode, 0);
assert.deepEqual(calls, { register: 2, stop: 0, start: 1 });

const registerSource = await Bun.file(join(import.meta.dir, "register-commands.ts")).text();
assert.match(registerSource, /PUT.*\/applications\/\$\{application\.id\}\/commands/);
assert.match(registerSource, /\[\.\.\.others, command\]/);
assert.doesNotMatch(registerSource, /POST.*\/applications\/\$\{application\.id\}\/commands/);

console.log("aira-cli tests: OK");
