import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { waitForBotReady } from "./start-readiness.js";

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

  const child = spawn(process.execPath, ["run", daemon], {
    cwd: root,
    stdio: "ignore",
    detached: true,
    env: process.env,
  });
  child.unref();

  const pid = child.pid;
  if (!pid) {
    console.error("[SUPERVISOR] Failed to start daemon: no pid returned");
    process.exit(1);
  }

  console.log(`[SUPERVISOR] Starting (pid ${pid})...`);
  const result = await waitForBotReady(
    async () => {
      try {
        const response = await fetch("http://127.0.0.1:${process.env.ISLA_HEALTH_PORT ?? "8091"}/health", {
          signal: AbortSignal.timeout(5_000),
        });
        if (!response.ok) return false;
        const body = (await response.json()) as { gatewayReady?: boolean };
        return body.gatewayReady === true;
      } catch {
        return false;
      }
    },
    () => running(pid),
  );

  if (result.ready) {
    console.log(`[SUPERVISOR] Ready (pid ${pid})`);
    process.exit(0);
  }

  if (running(pid)) {
    try { process.kill(pid, "SIGTERM"); } catch {}
  }
  console.error(`[SUPERVISOR] Start failed: ${result.reason}`);
  process.exit(1);
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
