import { lookup } from "node:dns/promises";

/**
 * Hosts the reply path resolves. Only the first few lookups matter (see `warmDns`), but
 * the soak keeps going until results are stable, so extra names give it room to confirm
 * it is actually done. All of these are hosts the bot talks to anyway.
 */
export const WARM_HOSTS = [
  "discord.com",
  "generativelanguage.googleapis.com",
  "media.discordapp.net",
  "gateway.discord.gg",
];

/** A lookup slower than this absorbed a stall instead of proving the resolver is warm. */
const STABLE_LOOKUP_MS = 500;

/** Consecutive fast lookups required before the soak stops. */
const STABLE_RUN = 2;

/** Hard cap per soak pass so a pathological resolver cannot make startup hang forever. */
const MAX_LOOKUPS = 12;

/** Passes of (sockets → soak) before giving up. Each extra clean pass costs ~100ms. */
const MAX_PASSES = 4;

export type DnsWarmStats = { lookups: number; stalls: number; ms: number };

/**
 * Measured on this host (Debian chroot on Android, resolver 1.1.1.1): `dns.lookup()` —
 * glibc getaddrinfo — stalls for ~5.0s at the start of every process, then answers in
 * ~25ms for the rest of its life. It is not the network (`dns.resolve4()` answers the
 * same name in ~15ms throughout), not the hostname (any name is slow first), not
 * address-family ordering (`setDefaultResultOrder()` changes nothing), and not one fixed
 * number of times: two stalls is the norm but a third can appear after a parallel fetch.
 *
 * Left alone, the user's first message pays for all of it. The first thing the reply path
 * does is POST the typing indicator, and the first thing the pipeline does is embed the
 * text — both land inside those stalls, which is the "Isla is very slow" symptom seen
 * right after every restart (measured baseline: typing 5.4s + embed 5.6s ≈ 11s before the
 * pipeline even starts).
 *
 * So this resolves throwaway names until two consecutive lookups come back fast, i.e.
 * until the resolver is demonstrably warm, and logs how many stalls it absorbed.
 *
 * Never throws: a failed warm-up only means the first request pays the usual cost,
 * exactly as before.
 */
export async function warmDns(
  hosts: readonly string[] = WARM_HOSTS,
  resolve: (host: string) => Promise<unknown> = (host) => lookup(host),
  budgetMs = Number.POSITIVE_INFINITY,
): Promise<DnsWarmStats> {
  const started = Date.now();
  if (!hosts.length) return { lookups: 0, stalls: 0, ms: 0 };

  let lookups = 0;
  let stalls = 0;
  let stable = 0;

  while (stable < STABLE_RUN && lookups < MAX_LOOKUPS && Date.now() - started < budgetMs) {
    const host = hosts[lookups % hosts.length];
    lookups++;
    const at = Date.now();
    try {
      await resolve(host);
    } catch {
      // An unreachable name still proves the resolver answered, which is the point.
    }
    if (Date.now() - at > STABLE_LOOKUP_MS) {
      stalls++;
      stable = 0;
    } else {
      stable++;
    }
  }

  return { lookups, stalls, ms: Date.now() - started };
}

/**
 * Cheap endpoints on each host. Both answer without credentials (the Gemini one with
 * 403), which is enough: the point is the DNS + TLS handshake, not the response body.
 * Deliberately no API key in the query string — a warm-up must not put a secret in a URL
 * that could end up in a log.
 */
export const WARM_URLS = [
  "https://discord.com/api/v10/gateway",
  "https://generativelanguage.googleapis.com/v1beta/models",
];

/**
 * Open a real HTTPS connection per host so the TLS handshake is paid while idle too.
 * Returns how many of those requests were themselves a stall (slower than
 * `STABLE_LOOKUP_MS`), which is how the absorbed cost is reported honestly: with the
 * sequential order below, the fetches usually eat the stalls before the soak sees any.
 *
 * Deliberately sequential. Concurrent lookups are what re-arm a stall: measured, three
 * parallel fetches absorbed one stall and left a second for the next lookup, while the
 * same three hosts fetched one after another absorbed both stalls inside themselves and
 * every lookup afterwards was clean (~25ms). Warming in parallel therefore never finishes
 * the job it is here to do.
 */
export async function warmHttps(
  urls: readonly string[] = WARM_URLS,
  get: (url: string) => Promise<unknown> = (url) => fetch(url, { method: "GET" }),
): Promise<number> {
  let stalls = 0;
  for (const url of urls) {
    const at = Date.now();
    try {
      await get(url);
    } catch {
      // Best effort, same as warmDns. A refused connection still resolved the name.
    }
    if (Date.now() - at > STABLE_LOOKUP_MS) stalls++;
  }
  return stalls;
}

export type WarmNetworkOptions = {
  hosts?: readonly string[];
  urls?: readonly string[];
  resolve?: (host: string) => Promise<unknown>;
  get?: (url: string) => Promise<unknown>;
  /** Stop after this much total time even if the resolver is not proven quiet. */
  budgetMs?: number;
};

/**
 * Open the sockets, then drain whatever stalls that created, and repeat until a full
 * pass comes back quiet.
 *
 * Order matters and is the opposite of what you might expect: the HTTPS warm-up is
 * itself concurrent DNS activity, and concurrency is what re-arms a stall — measured, a
 * parallel `fetch()` absorbs one 5s stall and can leave another one behind for the next
 * lookup. So soaking first and sockets second would hand the last stall back to the first
 * user message. Sockets first, soak second, guarantees the resolver is quiet at the
 * moment we stop.
 *
 * A second pass costs ~100ms (sockets are already pooled, the soak is two fast lookups)
 * and is what proves the first pass actually finished.
 *
 * `budgetMs` caps the whole thing (default 30s). The number of stalls is not fixed — the
 * bot's own startup traffic (gateway, REST, Chroma) re-arms them, and the first real run
 * absorbed four — so the soak is best-effort: whatever is left after the budget is paid
 * by the first reply, exactly as before, only less of it.
 *
 * No periodic re-warming is needed: measured connection pools stay warm through 60s of
 * idle (17-38ms after 5/10/30/60s).
 */
export async function warmNetwork(options: WarmNetworkOptions = {}): Promise<DnsWarmStats> {
  const hosts = options.hosts ?? WARM_HOSTS;
  const urls = options.urls ?? WARM_URLS;
  const budgetMs = options.budgetMs ?? 30_000;
  const started = Date.now();
  let lookups = 0;
  let stalls = 0;

  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const httpStalls = await warmHttps(urls, options.get);
    const soak = await warmDns(hosts, options.resolve, Math.max(0, budgetMs - (Date.now() - started)));
    lookups += soak.lookups;
    stalls += httpStalls + soak.stalls;
    if (httpStalls === 0 && soak.stalls === 0) break;
    if (Date.now() - started >= budgetMs) break;
  }

  return { lookups, stalls, ms: Date.now() - started };
}
