import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import "dotenv/config";
import { config } from "../src/config.js";
import { ensureChroma } from "./chroma-setup.js";
import { DEFAULT_WATCH, decideWatch, initialWatchState, type ProbeResult, type WatchState } from "./watchdog.js";

const root = resolve(import.meta.dir, "..");
const runtime = resolve(root, ".aira");
const logDir = resolve(runtime, "logs");
const pidFile = resolve(runtime, "supervisor.pid");
const logFile = resolve(logDir, "aira.log");

mkdirSync(logDir, { recursive: true });

function log(line: string) {
  const entry = `${new Date().toISOString()} ${line}`;
  appendFileSync(logFile, `${entry}\n`);
  console.log(entry);
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

async function prepareChroma(): Promise<string> {
  try {
    const executable = await ensureChroma(root);
    log(`[SUPERVISOR] Chroma executable ready: ${executable}`);
    return executable;
  } catch (error) {
    log(`[SUPERVISOR] Chroma setup failed: ${error instanceof Error ? error.message : String(error)}`);
    console.error(`[SUPERVISOR] Chroma setup failed: ${error instanceof Error ? error.message : String(error)}`);
    return stop(1);
  }
}

const chroma = await prepareChroma();

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

// --------------------------------------------------------------------------- bot + watchdog
//
// The watchdog lives in this foreground daemon. It owns the bot child and can respawn
// it.
//
// What it watches for is the quiet failure: the Discord websocket stops delivering MESSAGE_CREATE
// while the process keeps answering Chroma and looks perfectly alive in `ps`. A crash was always
// handled (the exit handler above); a hang was invisible, and "Isla is offline" needed a human.
// src/bot/health.ts reports `gatewayReady` from the same probe the [LIVENESS] log line prints, so
// the auto-heal and the diagnosis cannot disagree.

const HEALTH_URL = `http://127.0.0.1:${config.health.port}/health`;
const WATCH = DEFAULT_WATCH;

let watchState: WatchState = initialWatchState(Date.now());
let watchTimer: ReturnType<typeof setInterval> | undefined;

function spawnBot(): void {
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
    if (stopping || watchState.restarting) return;
    log(`[SUPERVISOR] Aira exited (${signal ?? code}); stopping`);
    void stop(1);
  });
  watchState = { ...watchState, botStartedAt: Date.now(), notReadyStreak: 0, restarting: false };
  log(`[SUPERVISOR] Aira pid ${airaProcess.pid}`);
}

async function probeHealth(): Promise<ProbeResult> {
  try {
    const response = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(5_000) });
    if (!response.ok) return { reachable: false, gatewayReady: false };
    const body = (await response.json()) as { gatewayReady?: boolean };
    return { reachable: true, gatewayReady: body?.gatewayReady === true };
  } catch {
    return { reachable: false, gatewayReady: false };
  }
}

async function restartBot(why: string, restarts: number, waitMs: number): Promise<void> {
  log(`[SUPERVISOR] ${why} — restarting bot (#${restarts}, backoff ${Math.round(waitMs / 1000)}s)`);
  await new Promise((r) => setTimeout(r, waitMs));
  if (stopping) {
    watchState = { ...watchState, restarting: false };
    return;
  }
  const old = airaProcess;
  if (old) {
    const waitExit = (ms: number) => new Promise<"exit" | "timeout">((r) => {
      const timer = setTimeout(() => r("timeout"), ms);
      old.once("exit", () => { clearTimeout(timer); r("exit"); });
    });
    try { old.kill("SIGTERM"); } catch {}
    if ((await waitExit(10_000)) === "timeout") {
      log(`[SUPERVISOR] bot ignored SIGTERM for 10s (pid ${old.pid}); sending SIGKILL`);
      try { old.kill("SIGKILL"); } catch {}
      if ((await waitExit(10_000)) === "timeout") {
        log(`[SUPERVISOR] bot (pid ${old.pid}) survived SIGKILL; spawning anyway`);
      }
    }
  }
  if (!stopping) spawnBot();
}

async function watch(): Promise<void> {
  if (stopping || !airaProcess) return;
  const probe = await probeHealth();
  const { state, action } = decideWatch(watchState, probe, Date.now(), WATCH);
  watchState = { ...state, restarting: state.restarting || action.kind === "restart" };

  switch (action.kind) {
    case "ignore":
      return;
    case "healthy":
      if (action.resetRestarts) {
        log(`[SUPERVISOR] bot healthy ${Math.round(WATCH.healthyResetMs / 60_000)}m+, restart counter reset`);
      }
      return;
    case "strike":
      log(`[SUPERVISOR] ${action.why} (${action.streak}/${action.limit})`);
      return;
    case "give-up":
      log(`[SUPERVISOR] bot dead for ${Math.round(action.sinceLastMs / 60_000)}m+ across ${action.restarts} restarts — giving up auto-restart, needs a human`);
      if (watchTimer) clearInterval(watchTimer);
      watchTimer = undefined;
      return;
    case "restart":
      await restartBot(action.why, action.restarts, action.waitMs);
      return;
  }
}

spawnBot();
log(`[SUPERVISOR] Started (pid ${process.pid}), Chroma pid ${chromaProcess.pid}, watching ${HEALTH_URL}`);
watchTimer = setInterval(() => void watch(), WATCH.intervalMs);
watchTimer.unref();

await new Promise<void>(() => {});
