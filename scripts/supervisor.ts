import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { config } from "../src/config.js";
import { waitForBotReady } from "./start-readiness.js";
import { parseProcessTable, selectAiraProcesses, type AiraProcess } from "./stop-all-instances.js";

const root = resolve(import.meta.dir, "..");
const daemon = resolve(import.meta.dir, "daemon.ts");
const pidFile = resolve(root, ".aira/supervisor.pid");

function running(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function findAiraProcesses(): AiraProcess[] {
  try {
    const table = execFileSync("ps", ["-eo", "pid=,args="], { encoding: "utf8" });
    return selectAiraProcesses(parseProcessTable(table));
  } catch {
    return [];
  }
}

async function stopAllAiraProcesses(): Promise<number> {
  const processes = findAiraProcesses();
  if (processes.length === 0) {
    try { await Bun.write(pidFile, ""); } catch {}
    return 0;
  }

  const unique = new Map<number, AiraProcess>();
  for (const entry of processes) unique.set(entry.pid, entry);

  for (const entry of unique.values()) {
    try { globalThis.process.kill(entry.pid, "SIGTERM"); } catch {}
  }

  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (!findAiraProcesses().some((entry) => unique.has(entry.pid))) break;
    await Bun.sleep(100);
  }

  const remaining = findAiraProcesses().filter((entry) => unique.has(entry.pid));
  for (const entry of remaining) {
    try { globalThis.process.kill(entry.pid, "SIGKILL"); } catch {}
  }

  try { await Bun.write(pidFile, ""); } catch {}
  return processes.length;
}

const command = process.argv[2] ?? "start";

if (command === "start") {
  if (existsSync(pidFile)) {
    const pid = Number(await Bun.file(pidFile).text());
    if (Number.isInteger(pid) && pid > 0 && running(pid)) {
      console.error(`[SUPERVISOR] Already running (pid ${pid})`);
      process.exit(1);
    }
  }

  // Run the daemon in the foreground so installers and service managers keep
  // the server logs attached to their terminal instead of silently daemonizing.
  const child = spawn(process.execPath, ["run", daemon], {
    cwd: root,
    stdio: "inherit",
    detached: false,
    env: process.env,
  });

  const forwardSignal = (signal: NodeJS.Signals) => {
    try { child.kill(signal); } catch {}
  };
  process.once("SIGINT", () => forwardSignal("SIGINT"));
  process.once("SIGTERM", () => forwardSignal("SIGTERM"));

  const code = await new Promise<number>((resolveExit) => {
    child.once("error", (error) => {
      console.error(`[SUPERVISOR] Failed to start daemon: ${error.message}`);
      resolveExit(1);
    });
    child.once("exit", (exitCode, signal) => {
      resolveExit(exitCode ?? (signal === "SIGINT" ? 130 : 1));
    });
  });
  process.exit(code);
}

if (command === "stop") {
  const count = await stopAllAiraProcesses();
  console.log(count === 0
    ? "[SUPERVISOR] Not running"
    : `[SUPERVISOR] Stopped ${count} Aira process(es)`);
  process.exit(0);
}

if (command === "logs") {
  const logFile = resolve(root, ".aira/logs/aira.log");
  if (!existsSync(logFile)) { console.log("[SUPERVISOR] No logs yet"); process.exit(0); }
  const tail = spawn("tail", ["-f", logFile], { stdio: "inherit" });
  process.once("SIGINT", () => tail.kill("SIGINT"));
  await new Promise<void>((resolve) => tail.once("exit", () => resolve()));
  process.exit(0);
}

console.error("Usage: bun run scripts/supervisor.ts [start|stop|logs]");
process.exit(1);
