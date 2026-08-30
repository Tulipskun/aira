import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const daemon = resolve(import.meta.dir, "daemon.ts");
const pidFile = resolve(root, ".aira/supervisor.pid");

function running(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

const command = process.argv[2] ?? "start";

if (command === "start") {
  if (existsSync(pidFile)) {
    const pid = Number(await Bun.file(pidFile).text());
    if (Number.isInteger(pid) && pid > 0 && running(pid)) {
      console.log(`[SUPERVISOR] Already running (pid ${pid})`);
      process.exit(0);
    }
  }
  const child = spawn(process.execPath, ["run", daemon], { cwd: root, stdio: "ignore", detached: true, env: process.env });
  child.unref();
  console.log(`[SUPERVISOR] Started (pid ${child.pid})`);
  process.exit(0);
}

if (command === "stop") {
  if (!existsSync(pidFile)) { console.log("[SUPERVISOR] Not running"); process.exit(0); }
  const pid = Number(await Bun.file(pidFile).text());
  if (!Number.isInteger(pid) || pid <= 0 || !running(pid)) {
    try { await Bun.write(pidFile, ""); } catch {}
    console.log("[SUPERVISOR] Not running");
    process.exit(0);
  }
  process.kill(pid, "SIGTERM");
  console.log(`[SUPERVISOR] Stop requested (pid ${pid})`);
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
