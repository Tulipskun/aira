import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export type AiraCommand = "help" | "start" | "stop" | "restart" | "status" | "log";

const root = resolve(import.meta.dir, "..");
const supervisor = resolve(import.meta.dir, "supervisor.ts");
const runtime = resolve(root, ".aira");
const pidFile = resolve(runtime, "supervisor.pid");
const logFile = resolve(runtime, "logs/aira.log");

export function buildCommand(args: string[]): { command: AiraCommand } {
  const value = args[0] ?? "help";
  if (value === "logs") return { command: "log" };
  if (["help", "start", "stop", "restart", "status", "log"].includes(value)) {
    return { command: value as AiraCommand };
  }
  throw new Error(`Unknown command: ${value}`);
}

function supervisorCommand(command: "start" | "stop"): number {
  const result = spawnSync(process.execPath, ["run", supervisor, command], {
    cwd: root,
    stdio: "inherit",
    env: process.env,
  });
  if (result.error) {
    console.error(`[AIRA] Failed to run supervisor: ${result.error.message}`);
    return 1;
  }
  return result.status ?? 1;
}

export function readStatus(projectRoot: string): { pid?: number; running: boolean } {
  const file = resolve(projectRoot, ".aira/supervisor.pid");
  if (!existsSync(file)) return { running: false };
  const pid = Number(readFileSync(file, "utf8").trim());
  if (!Number.isInteger(pid) || pid <= 0) return { running: false };
  try {
    process.kill(pid, 0);
    return { pid, running: true };
  } catch {
    return { pid, running: false };
  }
}

export function tailLog(file: string, lines: number): string {
  if (!existsSync(file)) return "";
  const text = readFileSync(file, "utf8").replace(/\n+$/, "");
  if (!text) return "";
  return text.split("\n").slice(-lines).join("\n");
}

function printStatus(): void {
  const status = readStatus(root);
  if (status.running) {
    console.log(`[AIRA] Running (supervisor pid ${status.pid})`);
  } else if (status.pid) {
    console.log(`[AIRA] Stopped (stale pid ${status.pid})`);
  } else {
    console.log("[AIRA] Stopped");
  }
}

function printLog(): void {
  const output = tailLog(logFile, 100);
  if (!output) {
    console.log("[AIRA] No logs yet");
    return;
  }
  console.log(output);
}

function usage(): void {
  console.log(`Usage: aira <command>\n\nCommands:\n  start    Start Aira\n  stop     Stop Aira\n  restart  Restart Aira\n  status   Show status\n  log      Show the last 100 log lines\n  logs     Alias for log\n  help     Show this help`);
}

const { command } = (() => {
  try {
    return buildCommand(process.argv.slice(2));
  } catch (error) {
    console.error(`[AIRA] ${error instanceof Error ? error.message : String(error)}`);
    usage();
    process.exit(1);
  }
})();

switch (command) {
  case "help":
    usage();
    break;
  case "start":
    process.exit(supervisorCommand("start"));
  case "stop":
    process.exit(supervisorCommand("stop"));
  case "restart": {
    const stopCode = supervisorCommand("stop");
    if (stopCode !== 0) process.exit(stopCode);
    process.exit(supervisorCommand("start"));
  }
  case "status":
    printStatus();
    break;
  case "log":
    printLog();
    break;
}
