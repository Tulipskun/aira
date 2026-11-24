/**
 * The watchdog decision, separated from the process that acts on it.
 *
 * `daemon.ts` owns the bot child process, so it is where a restart has to happen — but that makes
 * the decision logic awkward and dangerous to test against a live Discord connection: a watchdog
 * with a wrong threshold kills a healthy bot on every boot, which is strictly worse than the hang
 * it was written to fix.
 *
 * So the thresholds, the two-strike rule, the boot grace period and the give-up alarm all live
 * here as a pure function of (state, probe, clock), and `scripts/test-liveness.ts` exercises them
 * against a fake clock. `daemon.ts` keeps only the side effects.
 */

export interface WatchConfig {
  /** How often the daemon probes /health. */
  intervalMs: number;
  /** Time after a (re)start before the daemon is allowed to judge the bot. */
  graceMs: number;
  /** Consecutive bad probes required before restarting. */
  notReadyLimit: number;
  /** Give up auto-restarting after this many attempts. */
  maxRestarts: number;
  /** First restart waits this long; each later one doubles it. */
  backoffBaseMs: number;
  backoffCapMs: number;
  /** Healthy for this long and the restart counter is forgotten. */
  healthyResetMs: number;
}

export const DEFAULT_WATCH: WatchConfig = {
  // The bot's own heartbeat is 60s; probing faster than that adds no information.
  intervalMs: 20_000,
  // A boot pays warmNetwork() (~15s) plus the Discord handshake before the gateway can be READY.
  // Judging earlier would restart every healthy start.
  graceMs: 180_000,
  // discord.js reconnects inside a single interval routinely; restarting on the first blip would
  // be worse than the hang it fixes.
  notReadyLimit: 2,
  maxRestarts: 5,
  backoffBaseMs: 5_000,
  backoffCapMs: 60_000,
  healthyResetMs: 10 * 60_000,
};

export interface WatchState {
  botStartedAt: number;
  notReadyStreak: number;
  restarts: number;
  lastRestartAt: number;
  /** When the bot last became continuously healthy; 0 = not yet. */
  healthySince: number;
  /** A restart is already in flight. */
  restarting: boolean;
  /** The daemon is shutting down. */
  stopping: boolean;
}

export function initialWatchState(now: number): WatchState {
  return { botStartedAt: now, notReadyStreak: 0, restarts: 0, lastRestartAt: 0, healthySince: 0, restarting: false, stopping: false };
}

export interface ProbeResult {
  reachable: boolean;
  gatewayReady: boolean;
}

export type WatchAction =
  | { kind: "ignore"; reason: "stopping" | "restart-in-flight" | "no-bot" | "boot-grace" }
  | { kind: "healthy"; resetRestarts: boolean }
  | { kind: "strike"; why: string; streak: number; limit: number }
  | { kind: "restart"; why: string; restarts: number; waitMs: number }
  | { kind: "give-up"; why: string; restarts: number; sinceLastMs: number };

/** Why a probe is bad, in the words that go into the log. */
export function probeVerdict(probe: ProbeResult): string {
  return probe.reachable ? "gateway not ready" : "health endpoint unreachable";
}

export function backoffMs(restarts: number, cfg: WatchConfig): number {
  // `restarts` is the count *including* the one about to happen, so the first wait is the base.
  const exponent = Math.max(0, restarts - 1);
  return Math.min(cfg.backoffCapMs, cfg.backoffBaseMs * 2 ** exponent);
}

/**
 * Decide what to do about one probe result. Pure: it returns the next state and the action the
 * caller should take, and never touches a timer, a socket or a child process.
 */
export function decideWatch(
  state: WatchState,
  probe: ProbeResult,
  now: number,
  cfg: WatchConfig = DEFAULT_WATCH,
): { state: WatchState; action: WatchAction } {
  if (state.stopping) return { state, action: { kind: "ignore", reason: "stopping" } };
  if (state.restarting) return { state, action: { kind: "ignore", reason: "restart-in-flight" } };
  if (now - state.botStartedAt < cfg.graceMs) {
    return { state, action: { kind: "ignore", reason: "boot-grace" } };
  }

  if (probe.reachable && probe.gatewayReady) {
    const healthySince = state.healthySince === 0 ? now : state.healthySince;
    // Only forget the past after a *sustained* healthy stretch, so a bot that flaps every four
    // minutes cannot restart forever on a fresh allowance.
    const reset = state.restarts > 0 && now - healthySince >= cfg.healthyResetMs;
    return {
      state: { ...state, notReadyStreak: 0, healthySince, restarts: reset ? 0 : state.restarts },
      action: { kind: "healthy", resetRestarts: reset },
    };
  }

  const why = probeVerdict(probe);
  const streak = state.notReadyStreak + 1;
  if (streak < cfg.notReadyLimit) {
    return { state: { ...state, notReadyStreak: streak, healthySince: 0 }, action: { kind: "strike", why, streak, limit: cfg.notReadyLimit } };
  }

  if (state.restarts >= cfg.maxRestarts) {
    return {
      state: { ...state, notReadyStreak: 0, healthySince: 0 },
      action: { kind: "give-up", why, restarts: state.restarts, sinceLastMs: now - state.lastRestartAt },
    };
  }

  const restarts = state.restarts + 1;
  return {
    state: { ...state, notReadyStreak: 0, healthySince: 0, restarts, lastRestartAt: now },
    action: { kind: "restart", why, restarts, waitMs: backoffMs(restarts, cfg) },
  };
}
