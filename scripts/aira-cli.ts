import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export type AiraCommand = "help" | "start" | "stop" | "restart" | "status" | "log" | "register_commands" | "update";

type GitPullResult = { code: number; before: string; after: string };
type UpdateDeps = {
  gitPull: () => GitPullResult;
  registerCommands: () => number;
  restart: () => number;
};

const root = resolve(import.meta.dir, "..");
const supervisor = resolve(import.meta.dir, "supervisor.ts");
const registerCommands = resolve(import.meta.dir, "register-commands.ts");
const logFile = resolve(root, ".aira/logs/aira.log");

export function buildCommand(args: string[]): { command: AiraCommand } {
  const value = args[0] ?? "help";
  if (value === "logs") return { command: "log" };
  if (["help", "start", "stop", "restart", "status", "log", "register_commands", "update"].includes(value)) {
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

function restartAira(): number {
  const stopCode = supervisorCommand("stop");
  return stopCode === 0 ? supervisorCommand("start") : stopCode;
}

function gitHead(projectRoot: string): string {
  const result = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: projectRoot,
    encoding: "utf8",
    env: process.env,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`Failed to read git HEAD: ${result.error?.message ?? result.stderr?.toString().trim() ?? "unknown error"}`);
  }
  return result.stdout.trim();
}

function pullGitHub(projectRoot: string): GitPullResult {
  let before: string;
  try {
    before = gitHead(projectRoot);
  } catch (error) {
    console.error(`[AIRA] ${error instanceof Error ? error.message : String(error)}`);
    return { code: 1, before: "", after: "" };
  }

  const result = spawnSync("git", ["pull", "--ff-only"], {
    cwd: projectRoot,
    stdio: "inherit",
    env: process.env,
  });
  if (result.error) {
    console.error(`[AIRA] Failed to pull GitHub: ${result.error.message}`);
    return { code: 1, before, after: before };
  }
  if ((result.status ?? 1) !== 0) {
    return { code: result.status ?? 1, before, after: before };
  }

  try {
    return { code: 0, before, after: gitHead(projectRoot) };
  } catch (error) {
    console.error(`[AIRA] ${error instanceof Error ? error.message : String(error)}`);
    return { code: 1, before, after: before };
  }
}

export function hasRevisionChanged(before: string, after: string): boolean {
  return before !== after;
}

export async function runUpdate(_projectRoot: string, deps: UpdateDeps): Promise<number> {
  const pulled = deps.gitPull();
  if (pulled.code !== 0) return pulled.code;

  if (!hasRevisionChanged(pulled.before, pulled.after)) {
    console.log("[AIRA] Already up to date.");
    return 0;
  }

  console.log("[AIRA] Update detected; registering Discord commands...");
  const registerCode = deps.registerCommands();
  if (registerCode !== 0) return registerCode;

  console.log("[AIRA] Restarting Aira...");
  return deps.restart();
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
  console.log(`Usage: aira <command>\n\nCommands:\n  start              Start Aira\n  stop               Stop Aira\n  restart            Restart Aira\n  update             Pull GitHub and restart when updated\n  status             Show status\n  register_commands  Register/update Discord slash commands\n  log                Show the last 100 log lines\n  logs               Alias for log\n  help               Show this help`);
}

export async function main(args: string[] = process.argv.slice(2)): Promise<number> {
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
    case "restart":
      return restartAira();
    case "update":
      return runUpdate(root, {
        gitPull: () => pullGitHub(root),
        registerCommands: registerDiscordCommands,
        restart: restartAira,
      });
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

if (import.meta.main) process.exit(await main());
