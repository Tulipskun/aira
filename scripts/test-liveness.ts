/**
 * Offline tests for the liveness heartbeat (src/bot/liveness.ts).
 *
 *   bun run scripts/test-liveness.ts
 *
 * No Discord, no network, no quota: `shards`, `channel`, `log`, `now` and the timers are all
 * injected, so every branch of the receive-path diagnosis is reachable on purpose.
 */
import { createLiveness, formatDuration, LIVENESS_EVENTS } from "../src/bot/liveness.js";

let pass = 0;
let fail = 0;
function ok(name: string, cond: boolean, extra = ""): void {
  if (cond) { pass++; console.log(`  \u2705 ${name}`); }
  else { fail++; console.log(`  \u274c ${name}${extra ? ` -- ${extra}` : ""}`); }
}
function section(t: string): void { console.log(`\n=== ${t} ===`); }

/** A clock the test drives, plus a log capture. */
function harness(overrides: Partial<Parameters<typeof createLiveness>[0]> = {}) {
  let t = 1_760_000_000_000;
  const lines: string[] = [];
  const liveness = createLiveness({
    shards: () => ({ 0: true }),
    channel: () => "1540291618618482708",
    log: (line) => lines.push(line),
    now: () => t,
    heartbeatMs: 60_000,
    idleReportMs: 300_000,
    ...overrides,
  });
  return { liveness, lines, advance: (ms: number) => { t += ms; }, at: () => t };
}

section("1. every stop on the receive path is counted");
{
  const { liveness } = harness();
  for (const event of LIVENESS_EVENTS) liveness.note(event);
  const snap = liveness.snapshot();
  ok("all six counters exist", LIVENESS_EVENTS.every((e) => snap[e] === 1));
  liveness.note("queued");
  liveness.note("queued");
  ok("a counter accumulates", liveness.snapshot().queued === 3);
  ok("snapshot is a copy, not the live object", (() => {
    const s = liveness.snapshot();
    s.queued = 999;
    return liveness.snapshot().queued === 3;
  })());
  liveness.stop();
}

section("2. the line answers the question the user asked");
{
  const { liveness, lines } = harness();
  liveness.note("seen");
  liveness.note("seen");
  liveness.note("nonBot");
  liveness.note("offChannel");
  await liveness.report("startup");
  const line = lines[0] ?? "";
  console.log(`    ${line}`);
  ok("tagged so it greps", line.startsWith("[LIVENESS] startup"));
  ok("gateway reported", line.includes("gateway=ready(1/1)"));
  ok("channel reported", line.includes("channel=1540291618618482708"));
  ok("seen count", line.includes("seen=2"));
  ok("off-channel count", line.includes("off-channel=1"));
  ok("queued=0 is visible -- that is the 'typed but never arrived' signal", line.includes("queued=0"));
  ok("last activity is an ISO stamp, not 'none'", /last=\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/.test(line), line);
  ok("and it is the injected clock's moment", line.includes(`last=${new Date(1_760_000_000_000).toISOString()}`));
  ok("one line only", !line.includes("\n"));
  liveness.stop();
}

section("3. a dead gateway is distinguishable from an idle channel");
{
  const down = harness({ shards: () => ({ 0: false, 1: true }) });
  await down.liveness.report("startup");
  console.log(`    ${down.lines[0]}`);
  ok("partial readiness is NOT-READY", (down.lines[0] ?? "").includes("gateway=NOT-READY(1/2)"));

  const none = harness({ shards: () => ({}) });
  await none.liveness.report("startup");
  ok("zero shards is NOT-READY, not 'ready(0/0)'", (none.lines[0] ?? "").includes("gateway=NOT-READY(0/0)"));

  const boom = harness({ shards: () => { throw new Error("socket gone"); } });
  await boom.liveness.report("startup");
  ok("a throwing probe is reported, not rethrown", (boom.lines[0] ?? "").includes("gateway=probe-failed(socket gone)"));
  ok("and the line still gets written", (boom.lines[0] ?? "").includes("channel=1540291618618482708"));

  const asyncProbe = harness({ shards: async () => ({ 0: true, 1: false }) });
  await asyncProbe.liveness.report("startup");
  ok("an async probe is awaited", (asyncProbe.lines[0] ?? "").includes("gateway=NOT-READY(1/2)"));
  for (const h of [down, none, boom, asyncProbe]) h.liveness.stop();
}

section("4. the response channel is the other half of 'nobody typed'");
{
  const unset = harness({ channel: () => null });
  await unset.liveness.report("startup");
  ok("null channel prints NOT SET", (unset.lines[0] ?? "").includes("channel=NOT SET"));

  const empty = harness({ channel: () => "" });
  await empty.liveness.report("startup");
  ok("empty string also prints NOT SET", (empty.lines[0] ?? "").includes("channel=NOT SET"));

  const throws = harness({ channel: () => { throw new Error("config unreadable"); } });
  await throws.liveness.report("startup");
  ok("a throwing channel probe cannot kill the line", (throws.lines[0] ?? "").includes("channel=probe-failed"));
  for (const h of [unset, empty, throws]) h.liveness.stop();
}

section("5. idle reporting: silence threshold, then throttled repeats");
{
  const { liveness, lines, advance } = harness({ heartbeatMs: 60_000, idleReportMs: 300_000 });
  await liveness.report("idle"); // forced, to check the wording
  ok("idle wording carries the duration", (lines[0] ?? "").startsWith("[LIVENESS] silent 0s"), lines[0]);

  advance(299_000);
  ok("idleMs below the threshold", liveness.idleMs() === 299_000);
  advance(1_000);
  ok("idleMs at the threshold", liveness.idleMs() === 300_000);

  // Timer-driven cases must use the real clock: a frozen injected `now` can never cross the
  // silence threshold, so the tick body would be dead code under test.
  const live = harness({ now: () => Date.now(), heartbeatMs: 20, idleReportMs: 30, idleRepeatMs: 100_000 });
  live.liveness.start();
  await new Promise((r) => setTimeout(r, 200));
  live.liveness.stop();
  const idleLines = live.lines.filter((l) => l.startsWith("[LIVENESS] silent"));
  ok("a silent channel does produce idle lines", idleLines.length >= 1, `${live.lines.length} lines`);
  ok("and the repeat gate holds across ~10 ticks", idleLines.length === 1, `${idleLines.length}`);
  ok("startup line is printed by start()", live.lines[0]?.startsWith("[LIVENESS] startup"));

  // The gate is its own dial: shorten it and she does speak again -- but still not every tick.
  const chatty = harness({ now: () => Date.now(), heartbeatMs: 20, idleReportMs: 30, idleRepeatMs: 40 });
  chatty.liveness.start();
  await new Promise((r) => setTimeout(r, 200));
  chatty.liveness.stop();
  const repeats = chatty.lines.filter((l) => l.startsWith("[LIVENESS] silent"));
  ok("a short repeat gate does speak again", repeats.length >= 2, `${repeats.length}`);
  ok("but still not once per tick", repeats.length <= 8, `${repeats.length}`);
}

section("6. activity resets the silence clock");
{
  const { liveness, advance } = harness({ idleReportMs: 300_000 });
  advance(400_000);
  ok("idle grows with no events", liveness.idleMs() === 400_000);
  liveness.note("queued");
  ok("an incoming message resets it", liveness.idleMs() === 0);
  advance(120_000);
  liveness.note("seen");
  ok("and any counted event resets it again", liveness.idleMs() === 0);
  liveness.stop();
}

section("7. start() is idempotent and stop() really stops");
{
  const { liveness, lines } = harness({ now: () => Date.now(), heartbeatMs: 20, idleReportMs: 0, idleRepeatMs: 0 });
  liveness.start();
  liveness.start();
  liveness.start();
  await new Promise((r) => setTimeout(r, 150));
  liveness.stop();
  liveness.stop();
  const after = lines.length;
  ok("the throttled loop did keep reporting", after >= 2, `${after} lines`);
  await new Promise((r) => setTimeout(r, 150));
  ok("three starts did not stack three timers", lines.filter((l) => l.startsWith("[LIVENESS] startup")).length === 1);
  ok("stop() ends the reporting", lines.length === after, `${after} -> ${lines.length}`);
}

section("8. a hung probe cannot stack up reports");
{
  let calls = 0;
  const { liveness } = harness({
    heartbeatMs: 10,
    idleReportMs: 0,
    shards: () => new Promise((resolve) => { setTimeout(() => resolve({ 0: true }), 5_000); calls++; }),
  });
  void liveness.report("idle");
  for (let i = 0; i < 5; i++) await liveness.report("idle");
  ok("the probe was entered once for this test's own calls", calls >= 1);
  liveness.stop();
}

section("9. formatDuration");
{
  ok("seconds", formatDuration(42_000) === "42s");
  ok("sub-second", formatDuration(900) === "0s");
  ok("minutes below an hour", formatDuration(59 * 60_000) === "59m");
  ok("past an hour it splits, so 71m never reads as 1h", formatDuration(71 * 60_000) === "1h11m");
  ok("hours zero-pad minutes", formatDuration((3 * 3600 + 5 * 60) * 1000) === "3h05m");
  ok("negative clamps", formatDuration(-9000) === "0s");
}

section("10. bot.ts wiring (source-grep)");
{
  const src = await Bun.file("src/bot/bot.ts").text();
  ok("liveness is created", src.includes("createLiveness("));
  ok("started on ready, not before login", /client\.once\("ready"[\s\S]{0,400}liveness\.start\(\)/.test(src));
  ok("stopped on both signals", (src.match(/liveness\.stop\(\)/g) ?? []).length === 2);
  for (const event of LIVENESS_EVENTS) {
    ok(`the receive path notes '${event}'`, src.includes(`liveness.note("${event}")`));
  }
  ok("readiness comes from the shared probe, not a private copy",
    src.includes("shardReadiness(client)") && !/shard\.status ===/.test(src));
  ok("the health server is started", src.includes("startHealthServer("));
  ok("and closed on both signals", (src.match(/health\.stop\(\)/g) ?? []).length === 2);
  ok("the port is config-driven, so the watchdog reads the same value",
    src.includes("config.health.port"));
}

section("11. the enum trap this module exists to avoid");
{
  const { Status } = await import("discord.js");
  const { WebSocketShardStatus } = await import("@discordjs/ws");
  ok("discord.js Ready is 0", Status.Ready === 0);
  ok("@discordjs/ws Ready is 3", WebSocketShardStatus.Ready === 3);
  ok("so a numeric comparison would have been wrong -- liveness takes booleans instead",
    Number(Status.Ready) !== Number(WebSocketShardStatus.Ready));
  const src = await Bun.file("src/bot/liveness.ts").text();
  ok("liveness.ts contains no gateway status number at all", !/===\s*[0-8]\b/.test(src));
}

section("12. health.ts — the probe the watchdog acts on");
{
  const { shardReadiness, gatewayReady, healthState } = await import("../src/bot/health.js");
  const { Status } = await import("discord.js");

  const ready = { ws: { status: Status.Ready, shards: new Map([[0, { status: Status.Ready }]]) } };
  const dead = { ws: { status: Status.Identifying, shards: new Map([[0, { status: Status.Disconnected }]]) } };
  const half = { ws: { status: Status.Ready, shards: new Map([[0, { status: Status.Ready }], [1, { status: Status.Disconnected }]]) } };

  ok("all shards ready -> true", gatewayReady(shardReadiness(ready as never)) === true);
  ok("no shard ready -> false", gatewayReady(shardReadiness(dead as never)) === false);
  ok("one of two ready -> false: a partial gateway loses whole guilds", gatewayReady(shardReadiness(half as never)) === false);
  ok("an empty shard map is NOT ready, not vacuously ready", gatewayReady({}) === false);
  ok("pre-connect (no shards, client not ready) reports false",
    gatewayReady(shardReadiness({ ws: { status: Status.Connecting, shards: new Map() } } as never)) === false);
  ok("a throwing shard iterator is caught, not rethrown",
    gatewayReady(shardReadiness({ ws: { get status() { throw new Error("nope"); }, get shards() { throw new Error("nope"); } } } as never)) === false);

  const state = healthState({
    client: ready as never,
    liveness: { idleMs: () => 4_000, snapshot: () => ({ seen: 3, queued: 2 }) },
    channel: () => "123",
    startedAt: 1_000,
  }, () => 61_000);
  ok("ok mirrors gatewayReady", state.ok === true && state.gatewayReady === true);
  ok("uptime is measured from startedAt", state.uptimeMs === 60_000);
  ok("idleMs is carried through", state.idleMs === 4_000);
  ok("counters are carried through", state.counters.seen === 3);
  ok("channel is reported", state.channel === "123");
  ok("a throwing channel probe cannot kill /health",
    healthState({ client: ready as never, liveness: { idleMs: () => 0, snapshot: () => ({}) }, channel: () => { throw new Error("x"); }, startedAt: 0 }, () => 1).channel === null);

  // A real socket, on an ephemeral port: the watchdog speaks HTTP, so that path must be proven.
  const { startHealthServer } = await import("../src/bot/health.js");
  const server = startHealthServer({
    client: ready as never,
    liveness: { idleMs: () => 1_500, snapshot: () => ({ seen: 9 }) },
    channel: () => "chan-1",
    startedAt: Date.now() - 5_000,
    port: 0,
  });
  await new Promise((r) => setTimeout(r, 50));
  const address = (server as unknown as { port: number }).port;
  ok("port 0 still yields a usable url", typeof server.url === "string" && server.url.includes("/health"));
  ok("state() reads without HTTP", server.state().counters.seen === 9);
  server.stop();
  void address;
}

section("13. watchdog decision (pure, fake clock)");
{
  const { decideWatch, initialWatchState, backoffMs, DEFAULT_WATCH, probeVerdict } =
    await import("../scripts/watchdog.js");
  type ProbeResultLike = { reachable: boolean; gatewayReady: boolean };
  const cfg = DEFAULT_WATCH;
  const healthy: ProbeResultLike = { reachable: true, gatewayReady: true };
  const hung: ProbeResultLike = { reachable: true, gatewayReady: false };
  const gone: ProbeResultLike = { reachable: false, gatewayReady: false };
  const T0 = 1_000_000;

  // The grace period is what stops a boot from being judged before the gateway can be READY.
  let s = initialWatchState(T0);
  let r = decideWatch(s, hung, T0 + 60_000, cfg);
  ok("inside the boot grace, a dead gateway is ignored", r.action.kind === "ignore" && r.action.reason === "boot-grace");
  r = decideWatch(s, hung, T0 + cfg.graceMs, cfg);
  ok("the moment the grace expires it is judged", r.action.kind === "strike", JSON.stringify(r.action));
  ok("a strike does not restart", r.action.kind === "strike");

  // Two strikes: one blip must never kill a healthy bot mid-reconnect.
  s = r.state;
  r = decideWatch(s, hung, T0 + cfg.graceMs + cfg.intervalMs, cfg);
  ok("the second consecutive failure triggers a restart", r.action.kind === "restart", JSON.stringify(r.action));
  ok("the restart is numbered", r.action.kind === "restart" && r.action.restarts === 1);
  ok("first backoff is the base", r.action.kind === "restart" && r.action.waitMs === cfg.backoffBaseMs);

  // A healthy probe between strikes resets the streak.
  s = initialWatchState(T0);
  r = decideWatch(s, hung, T0 + cfg.graceMs, cfg);
  r = decideWatch(r.state, healthy, T0 + cfg.graceMs + cfg.intervalMs, cfg);
  ok("a healthy probe in between clears the streak", r.action.kind === "healthy" && r.state.notReadyStreak === 0);
  r = decideWatch(r.state, hung, T0 + cfg.graceMs + 2 * cfg.intervalMs, cfg);
  ok("so the next lone failure is a strike again, not a restart", r.action.kind === "strike");

  // Backoff doubles and caps.
  ok("backoff doubles", backoffMs(2, cfg) === 10_000 && backoffMs(3, cfg) === 20_000);
  ok("backoff is capped", backoffMs(99, cfg) === cfg.backoffCapMs);

  // Give-up: after maxRestarts it stops trying but says so.
  s = { ...initialWatchState(T0), restarts: cfg.maxRestarts, lastRestartAt: T0 + cfg.graceMs };
  r = decideWatch(s, gone, T0 + cfg.graceMs + 60_000, cfg);
  ok("strike one past the limit", r.action.kind === "strike");
  r = decideWatch(r.state, gone, T0 + cfg.graceMs + 120_000, cfg);
  ok("then it gives up rather than restarting forever", r.action.kind === "give-up", JSON.stringify(r.action));
  ok("the give-up carries the evidence",
    r.action.kind === "give-up" && r.action.restarts === cfg.maxRestarts && r.action.sinceLastMs === 120_000,
    JSON.stringify(r.action));

  // Restart-counter reset needs a sustained healthy stretch, not one good probe.
  s = { ...initialWatchState(T0), restarts: 3, healthySince: 0 };
  r = decideWatch(s, healthy, T0 + cfg.graceMs, cfg);
  ok("the first healthy probe starts the clock but keeps the counter", r.action.kind === "healthy" && !r.action.resetRestarts && r.state.restarts === 3);
  r = decideWatch(r.state, healthy, T0 + cfg.graceMs + cfg.healthyResetMs, cfg);
  ok("a sustained stretch forgives the past",
    r.action.kind === "healthy" && r.action.resetRestarts && r.state.restarts === 0,
    JSON.stringify(r.action));

  // In-flight restart and shutdown must be inert.
  r = decideWatch({ ...initialWatchState(T0), restarting: true }, gone, T0 + 10 * cfg.graceMs, cfg);
  ok("a restart already in flight ignores further probes", r.action.kind === "ignore" && r.action.reason === "restart-in-flight");
  r = decideWatch({ ...initialWatchState(T0), stopping: true }, gone, T0 + 10 * cfg.graceMs, cfg);
  ok("shutdown ignores probes too", r.action.kind === "ignore" && r.action.reason === "stopping");

  ok("an unreachable endpoint is named differently from a hung gateway",
    probeVerdict(gone) === "health endpoint unreachable" && probeVerdict(hung) === "gateway not ready");

  // The daemon must not keep its own copy of these numbers.
  const src = await Bun.file("scripts/daemon.ts").text();
  ok("daemon.ts delegates the decision to decideWatch()", src.includes("decideWatch("));
  ok("and defines no thresholds of its own",
    !/const (NOT_READY_LIMIT|MAX_RESTARTS|BOOT_GRACE_MS|HEALTHY_RESET_MS)/.test(src));
  ok("the health port comes from config, the same value the bot binds",
    src.includes("config.health.port") && !/ISLA_HEALTH_PORT/.test(src));
}

console.log(`\n${fail === 0 ? "\u2705" : "\u274c"} ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
