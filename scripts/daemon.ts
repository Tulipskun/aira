import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const runtime = resolve(root, ".aira");
const logDir = resolve(runtime, "logs");
const pidFile = resolve(runtime, "supervisor.pid");
const logFile = resolve(logDir, "aira.log");
const chromaBin = resolve(runtime, "chroma-venv/bin/chroma");
const chroma = existsSync(chromaBin) ? chromaBin : "chroma";

mkdirSync(logDir, { recursive: true });

function log(line: string) {
  appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`);
}

function isRunning(pid: number) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

if (existsSync(pidFile)) {
  const pid = Number(readFileSync(pidFile, "utf8"));
  if (Number.isInteger(pid) && pid > 0 && isRunning(pid)) {
    console.error(`[SUPERVISOR] Already running (pid ${pid})`);
    process.exit(1);
  }
  unlinkSync(pidFile);
}

writeFileSync(pidFile, String(process.pid));
let stopping = false;
let chromaProcess: ReturnType<typeof spawn> | undefined;
let airaProcess: ReturnType<typeof spawn> | undefined;

// Returns a promise that never resolves: callers must never continue past stop().
// Previously this fell through to the spawn() below, leaving bot.ts orphaned after a failed start.
function stop(code = 0): Promise<never> {
  if (!stopping) {
    stopping = true;
    log("[SUPERVISOR] Stopping services");
    const children = [airaProcess, chromaProcess];
    for (const child of children) {
      try { child?.kill("SIGTERM"); } catch {}
    }
    setTimeout(() => {
      for (const child of children) {
        try { child?.kill("SIGKILL"); } catch {}
      }
      try { unlinkSync(pidFile); } catch {}
      process.exit(code);
    }, 1000);
  }
  return new Promise<never>(() => {});
}

process.once("SIGTERM", () => stop(0));
process.once("SIGINT", () => stop(0));

chromaProcess = spawn(chroma, ["run", "--path", resolve(runtime, "chroma"), "--host", "127.0.0.1", "--port", "8000"], {
  cwd: root,
  stdio: ["ignore", "pipe", "pipe"],
  detached: false,
});
chromaProcess.stdout?.on("data", (d) => log(`[CHROMA] ${String(d).trimEnd()}`));
chromaProcess.stderr?.on("data", (d) => log(`[CHROMA] ${String(d).trimEnd()}`));
chromaProcess.once("error", (err) => {
  log(`[SUPERVISOR] Chroma failed to start (${(err as NodeJS.ErrnoException).code ?? err.message})`);
  void stop(1);
});
chromaProcess.once("exit", (code, signal) => {
  if (!stopping) { log(`[SUPERVISOR] Chroma exited (${signal ?? code}); stopping Aira`); void stop(1); }
});

// Chroma cold start on this host measures ~29s, which the old 30s deadline could not absorb.
const deadline = Date.now() + 120_000;
while (Date.now() < deadline) {
  try {
    const response = await fetch("http://127.0.0.1:8000/api/v2/heartbeat");
    if (response.ok) break;
  } catch {}
  if (chromaProcess.exitCode !== null) break;
  await Bun.sleep(250);
}
if (Date.now() >= deadline) log("[SUPERVISOR] Chroma startup timeout");
if (chromaProcess.exitCode !== null || Date.now() >= deadline) await stop(1);

// process.execPath, not "bun": bun is not on PATH in this host's non-login shells.
airaProcess = spawn(process.execPath, ["run", "src/bot/bot.ts"], {
  cwd: root,
  stdio: ["ignore", "pipe", "pipe"],
  env: process.env,
  detached: false,
});
airaProcess.stdout?.on("data", (d) => log(`[AIRA] ${String(d).trimEnd()}`));
airaProcess.stderr?.on("data", (d) => log(`[AIRA] ${String(d).trimEnd()}`));
airaProcess.once("error", (err) => {
  log(`[SUPERVISOR] Aira failed to start (${(err as NodeJS.ErrnoException).code ?? err.message})`);
  void stop(1);
});
airaProcess.once("exit", (code, signal) => {
  if (!stopping) { log(`[SUPERVISOR] Aira exited (${signal ?? code}); stopping`); void stop(1); }
});
log(`[SUPERVISOR] Started (pid ${process.pid}), Chroma pid ${chromaProcess.pid}, Aira pid ${airaProcess.pid}`);

// Keep the daemon alive while its children run.
await new Promise<void>(() => {});
