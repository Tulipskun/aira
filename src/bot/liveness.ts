/**
 * Liveness heartbeat for the Discord receive path.
 *
 * `bot.ts` used to log *nothing* while receiving: the first line a turn produced was the reply.
 * So "Isla went quiet" had two indistinguishable explanations — nobody typed, or the gateway
 * stopped delivering events while the process sat there looking healthy. This counts each place
 * an incoming message can stop, and once the channel has been silent for a while it prints that
 * tally together with the shard status and the response channel it is actually listening on.
 *
 * Reading the line:
 *   gateway=ready + queued=0 after a user swears they typed  -> events never arrived; restart heals it
 *   gateway=ready + off-channel=N                           -> people are typing in another channel
 *   channel=NOT SET                                         -> getResponseChannelId() is null, so
 *                                                              bot.ts ignores every message by design
 *
 * Nothing here heals anything — a dead websocket stays dead until the process restarts. It only
 * makes the difference visible in `aira.log`.
 */

/** Every counter the receive path can stop at, in the order a message meets them. */
export const LIVENESS_EVENTS = [
  "seen",
  "nonBot",
  "command",
  "offChannel",
  "dropped",
  "queued",
] as const;

export type LivenessEvent = (typeof LIVENESS_EVENTS)[number];

export type LivenessCounters = Record<LivenessEvent, number>;

export const DEFAULT_HEARTBEAT_MS = 60_000;

/** Only after this much silence does a heartbeat say something interesting. */
export const DEFAULT_IDLE_REPORT_MS = 5 * 60_000;

export interface Liveness {
  /** Record that the receive path reached `event`. Also stamps "last activity". */
  note(event: LivenessEvent): void;
  snapshot(): LivenessCounters;
  /** Print one line now (used at startup and by tests). */
  report(reason?: "startup" | "idle"): Promise<void>;
  start(): void;
  stop(): void;
  /** ms since the last noted event, or since start if there was none. */
  idleMs(): number;
}

export interface LivenessDeps {
  /**
   * Shard id -> is that shard READY (the only state in which MESSAGE_CREATE can arrive).
   *
   * A boolean, deliberately: discord.js overwrites the raw `WebSocketShardStatus` numbers with its
   * own `Status` enum at runtime, where **Ready is 0** but `@discordjs/ws` says **Ready is 3**. A
   * numeric comparison here would silently report "NOT-READY" forever while the bot works fine.
   * The caller maps through `Status.Ready` and this module never sees a magic number.
   */
  shards(): Record<number, boolean> | Promise<Record<number, boolean>>;
  /** The channel id being listened on; `null`/empty means "not set". */
  channel(): string | null | undefined;
  log?: (line: string) => void;
  now?: () => number;
  heartbeatMs?: number;
  idleReportMs?: number;
  /** Repeat an idle line at most this often. Default: `idleReportMs`. */
  idleRepeatMs?: number;
}

export function createLiveness(deps: LivenessDeps): Liveness {
  const now = deps.now ?? (() => Date.now());
  const log = deps.log ?? ((line: string) => console.log(line));
  const heartbeatMs = deps.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const idleReportMs = deps.idleReportMs ?? DEFAULT_IDLE_REPORT_MS;
  const idleRepeatMs = deps.idleRepeatMs ?? idleReportMs;

  const counts = {} as LivenessCounters;
  for (const event of LIVENESS_EVENTS) counts[event] = 0;

  let startedAt = now();
  let lastEventAt: number | null = null;
  let lastIdleReportAt: number | null = null;
  let timer: ReturnType<typeof setInterval> | undefined;
  let reporting: Promise<void> | undefined;

  function idleMs(): number {
    return now() - (lastEventAt ?? startedAt);
  }

  /** One line, so a grep cannot cut the diagnosis in half. */
  async function buildLine(reason: "startup" | "idle"): Promise<string> {
    const parts = [
      `[LIVENESS] ${reason === "startup" ? "startup" : `silent ${formatDuration(idleMs())}`}`,
    ];

    let gateway = "unknown";
    try {
      const shards = await deps.shards();
      const ids = Object.keys(shards);
      const ready = ids.filter((id) => shards[Number(id)]).length;
      gateway = `${ids.length > 0 && ready === ids.length ? "ready" : "NOT-READY"}(${ready}/${ids.length})`;
    } catch (error) {
      gateway = `probe-failed(${short(error)})`;
    }
    parts.push(`gateway=${gateway}`);

    let channel: string;
    try {
      channel = deps.channel() || "NOT SET";
    } catch {
      channel = "probe-failed";
    }
    parts.push(`channel=${channel}`);

    parts.push(
      `messages seen=${counts.seen}` +
        ` (non-bot=${counts.nonBot}, queued=${counts.queued},` +
        ` off-channel=${counts.offChannel}, command=${counts.command}, dropped=${counts.dropped})`,
    );
    parts.push(`last=${lastEventAt === null ? "none since start" : new Date(lastEventAt).toISOString()}`);
    return parts.join(", ");
  }

  async function report(reason: "startup" | "idle" = "startup"): Promise<void> {
    // A probe failure must never become an unhandled rejection: this runs from a timer, and an
    // unhandled rejection takes the whole process down (see the pipeline's onFlush guard).
    try {
      if (reason === "idle") lastIdleReportAt = now();
      log(await buildLine(reason));
    } catch (error) {
      log(`[LIVENESS] report failed: ${short(error)}`);
    }
  }

  async function tick(): Promise<void> {
    if (reporting) return; // a hung probe must not stack up timers
    if (idleMs() < idleReportMs) return;
    if (lastIdleReportAt !== null && now() - lastIdleReportAt < idleRepeatMs) return;
    reporting = report("idle");
    try {
      await reporting;
    } finally {
      reporting = undefined;
    }
  }

  function start(): void {
    if (timer) return;
    startedAt = now();
    lastIdleReportAt = null; // a restart must not inherit the previous run's repeat gate
    void report("startup");
    timer = setInterval(() => void tick(), heartbeatMs);
    timer.unref?.();
  }

  function stop(): void {
    if (timer) clearInterval(timer);
    timer = undefined;
  }

  return {
    note(event) {
      counts[event] = (counts[event] ?? 0) + 1;
      lastEventAt = now();
    },
    snapshot: () => ({ ...counts }),
    report,
    start,
    stop,
    idleMs,
  };
}

function short(error: unknown): string {
  return String((error as Error)?.message ?? error).slice(0, 60);
}

/** "42s", "71m", "3h05m" — long enough to spot a stale session, short enough for one line. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  if (h > 0) return `${h}h${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}
