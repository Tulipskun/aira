/**
 * The bot's own health endpoint — the thing `scripts/daemon.ts` polls to decide whether to
 * restart it.
 *
 * The failure this exists for is the quiet one: the Discord websocket stops delivering
 * MESSAGE_CREATE while the process keeps answering Chroma and looks perfectly alive in `ps`.
 * `liveness.ts` made that visible in the log; this makes it *actionable*, because a log line
 * still needs someone to be reading it.
 *
 * `gatewayReady` comes from the same `shardReadiness()` the [LIVENESS] line uses, so the
 * diagnosis and the auto-heal can never disagree about whether she is listening — two sources of
 * truth there would be worse than neither.
 *
 * Bound to 127.0.0.1 only, and a bind failure is logged rather than thrown: losing the probe must
 * never cost the bot its Discord connection.
 */

import { createServer, type Server } from "node:http";
import { Status } from "discord.js";

/** Minimal shape of the client this module needs; keeps it testable without a real connection. */
export interface ReadinessClient {
  ws: {
    status: Status;
    shards: Iterable<[number, { status: Status }]>;
  };
}

/**
 * Shard id -> is that shard READY (the only state in which MESSAGE_CREATE can arrive).
 *
 * Both sides are booleans on purpose. discord.js overwrites the raw `WebSocketShardStatus` numbers
 * with its own `Status` enum on the shard object, and the two disagree: `Status.Ready` is 0 while
 * `WebSocketShardStatus.Ready` is 3. A numeric comparison would report the gateway as dead on a
 * perfectly healthy connection.
 */
export function shardReadiness(client: ReadinessClient): Record<number, boolean> {
  const flags: Record<number, boolean> = {};
  try {
    for (const [shardId, shard] of client.ws.shards) flags[shardId] = shard.status === Status.Ready;
  } catch {
    return { 0: false };
  }
  // No shards yet: pre-connect, or the gateway dropped every one of them. Either way she cannot
  // be receiving, so this must not read as "vacuously ready".
  if (Object.keys(flags).length === 0) flags[0] = client.ws.status === Status.Ready;
  return flags;
}

/** Every shard must be READY: a partial gateway silently loses whole guilds. */
export function gatewayReady(flags: Record<number, boolean>): boolean {
  const values = Object.values(flags);
  return values.length > 0 && values.every(Boolean);
}

export interface HealthDeps {
  client: ReadinessClient;
  /** Structural rather than the Liveness type, so tests need no Discord import. */
  liveness: {
    idleMs(): number;
    snapshot(): Record<string, number>;
  };
  /** The channel being listened on; null/empty means `bot.ts` ignores every message by design. */
  channel(): string | null | undefined;
  startedAt: number;
  port?: number;
  host?: string;
}

export interface HealthState {
  ok: boolean;
  gatewayReady: boolean;
  shards: Record<number, boolean>;
  uptimeMs: number;
  idleMs: number;
  channel: string | null;
  counters: Record<string, number>;
  /** Epoch ms — lets a watchdog tell a fresh boot from a process broken for hours. */
  ts: number;
}

export interface HealthServer {
  url: string;
  /** The body /health serves right now, readable without making an HTTP request. */
  state(): HealthState;
  stop(): void;
}

export function healthState(deps: HealthDeps, now: () => number = () => Date.now()): HealthState {
  const shards = shardReadiness(deps.client);
  let channel: string | null = null;
  try {
    channel = deps.channel() || null;
  } catch {
    channel = null;
  }
  const ready = gatewayReady(shards);
  return {
    ok: ready,
    gatewayReady: ready,
    shards,
    uptimeMs: Math.max(0, now() - deps.startedAt),
    idleMs: deps.liveness.idleMs(),
    channel,
    counters: deps.liveness.snapshot(),
    ts: now(),
  };
}

export function startHealthServer(deps: HealthDeps): HealthServer {
  const port = deps.port ?? 8091;
  const host = deps.host ?? "127.0.0.1";
  const now = () => Date.now();

  const server: Server = createServer((_req, res) => {
    // One route, and it must answer even when everything else is broken — that is the point.
    let body: string;
    let code = 200;
    try {
      body = JSON.stringify(healthState(deps, now));
    } catch (error) {
      code = 500;
      body = JSON.stringify({ ok: false, error: String((error as Error)?.message ?? error), ts: now() });
    }
    res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(body);
  });

  server.on("error", (error) => {
    // EADDRINUSE / EACCES: the probe is a diagnostic, not a dependency.
    console.log(`[HEALTH] not listening on ${host}:${port} — ${String((error as Error)?.message ?? error)}`);
  });

  try {
    server.listen(port, host);
  } catch (error) {
    console.log(`[HEALTH] failed to start — ${String((error as Error)?.message ?? error)}`);
  }

  return {
    url: `http://${host}:${port}/health`,
    state: () => healthState(deps, now),
    stop: () => server.close(),
  };
}
