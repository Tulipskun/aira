import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
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

let chroma: string;
try {
  chroma = await ensureChroma(root);
  log(`[SUPERVISOR] Chroma executable ready: ${chroma}`);
} catch (error) {
  log(`[SUPERVISOR] Chroma setup failed: ${error instanceof Error ? error.message : String(error)}`);
  console.error(`[SUPERVISOR] Chroma setup failed: ${error instanceof Error ? error.message : String(error)}`);
  await stop(1);
}

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

// --------------------------------------------------------------------------- bot + watchdog
//
// The watchdog lives here, not in supervisor.ts: `supervisor.ts start` spawns this daemon detached
// and exits immediately, so it can observe nothing. This process owns the bot child and can respawn
// it.
//
// What it watches for is the quiet failure: the Discord websocket stops delivering MESSAGE_CREATE
// while the process keeps answering Chroma and looks perfectly alive in `ps`. A crash was always
// handled (the exit handler above); a hang was invisible, and "Isla is offline" needed a human.
// src/bot/health.ts reports `gatewayReady` from the same probe the [LIVENESS] log line prints, so
// the auto-heal and the diagnosis cannot disagree.

// The port comes from config.ts — the same value src/bot/bot.ts binds. Two literals here would
// mean a `.env` override makes the daemon poll a port nobody listens to, and it would then
// restart a perfectly healthy bot forever.
const HEALTH_URL = `http://127.0.0.1:${config.health.port}/health`;
const WATCH = DEFAULT_WATCH;

let watchState: WatchState = initialWatchState(Date.now());
let watchTimer: ReturnType<typeof setInterval> | undefined;

// process.execPath, not "bun": bun is not on PATH in this host's non-login shells.
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
    // A restart kills the child on purpose, so the exit handler must not treat it as a crash and
    // tear Chroma down with it.
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
    // Unreachable covers "process gone", "port never bound" and "event loop wedged". All three
    // deserve the same verdict as a dead gateway: users cannot reach her either way.
    return { reachable: false, gatewayReady: false };
  }
}

async function restartBot(why: string, restarts: number, waitMs: number): Promise<void> {
  log(`[SUPERVISOR] ${why} — restarting bot (#${restarts}, backoff ${Math.round(waitMs / 1000)}s)`);
  await new Promise((r) => setTimeout(r, waitMs));
  if (stopping) {
    // Never continue past a stop request: this exact fall-through is what used to orphan bot.ts
    // after a failed start.
    watchState = { ...watchState, restarting: false };
    return;
  }
  const old = airaProcess;
  if (old) {
    // A fresh promise per wait: a resolved one cannot be re-awaited to mean "wait again".
    const waitExit = (ms: number) => new Promise<"exit" | "timeout">((r) => {
      const timer = setTimeout(() => r("timeout"), ms);
      old.once("exit", () => { clearTimeout(timer); r("exit"); });
    });
    try { old.kill("SIGTERM"); } catch {}
    if ((await waitExit(10_000)) === "timeout") {
      // The case we are restarting for is often a process that no longer runs its event loop, so
      // it cannot honour SIGTERM either. Without this escalation the old process keeps holding
      // port 8091, the replacement cannot bind it, and the watchdog restarts forever and then
      // gives up — a self-inflicted version of the outage it was meant to cure.
      log(`[SUPERVISOR] bot ignored SIGTERM for 10s (pid ${old.pid}); sending SIGKILL`);
      try { old.kill("SIGKILL"); } catch {}
      if ((await waitExit(10_000)) === "timeout") {
        // Still alive. Spawn anyway: a second bot that cannot bind the port is louder in the log
        // than no bot at all, and the give-up counter will stop the loop.
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
  // `restarting` is set by the caller after decideWatch, so carry it forward explicitly.
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
      // Stop trying, but say it out loud with the evidence. A restart loop that never converges
      // hides the problem better than one loud line does.
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

// Keep the daemon alive while its children run.
await new Promise<void>(() => {});
