import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export type AiraCommand = "help" | "start" | "stop" | "restart" | "status" | "log" | "register_commands";

const root = resolve(import.meta.dir, "..");
const supervisor = resolve(import.meta.dir, "supervisor.ts");
const registerCommands = resolve(import.meta.dir, "register-commands.ts");
const logFile = resolve(root, ".aira/logs/aira.log");

export function buildCommand(args: string[]): { command: AiraCommand } {
  const value = args[0] ?? "help";
  if (value === "logs") return { command: "log" };
  if (["help", "start", "stop", "restart", "status", "log", "register_commands"].includes(value)) {
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

function registerDiscordCommands(): number {
  const result = spawnSync(process.execPath, ["run", registerCommands], {
    cwd: root,
    stdio: "inherit",
    env: process.env,
  });
  if (result.error) {
    console.error(`[AIRA] Failed to register Discord commands: ${result.error.message}`);
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
  console.log(`Usage: aira <command>\n\nCommands:\n  start              Start Aira\n  stop               Stop Aira\n  restart            Restart Aira\n  status             Show status\n  register_commands  Register/update Discord slash commands\n  log                Show the last 100 log lines\n  logs               Alias for log\n  help               Show this help`);
}

export function main(args: string[] = process.argv.slice(2)): number {
  let command: AiraCommand;
  try {
    command = buildCommand(args).command;
  } catch (error) {
    console.error(`[AIRA] ${error instanceof Error ? error.message : String(error)}`);
    usage();
    return 1;
  }

  switch (command) {
    case "help":
      usage();
      return 0;
    case "start":
      return supervisorCommand("start");
    case "stop":
      return supervisorCommand("stop");
    case "restart": {
      const stopCode = supervisorCommand("stop");
      return stopCode === 0 ? supervisorCommand("start") : stopCode;
    }
    case "status":
      printStatus();
      return 0;
    case "register_commands":
      return registerDiscordCommands();
    case "log":
      printLog();
      return 0;
  }
}

if (import.meta.main) process.exit(main());
