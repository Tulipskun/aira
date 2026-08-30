import { Routes, type Client } from "discord.js";

/**
 * Discord expires a typing indicator after ~10 seconds, so the loop has to re-arm it
 * faster than that. 8s leaves headroom for REST latency without burning rate limit.
 */
export const TYPING_INTERVAL_MS = 8_000;

/** Minimum gap between two sends triggered by `poke()` (many messages arriving at once). */
const TYPING_MIN_GAP_MS = 1_000;

/** Don't log the same failing channel more than once per minute. */
const TYPING_ERROR_LOG_COOLDOWN_MS = 60_000;

export type SendTypingResult = { ok: boolean; reason?: "no-channel" | "error" };

/**
 * Fire a single "Isla is typing…" indicator in `channelId`.
 *
 * Posts straight to `POST /channels/{id}/typing` instead of
 * `channels.fetch(id).sendTyping()`: the fetch is a second REST round-trip whose only
 * purpose is to re-derive what the caller already knows (the channel is text-based —
 * it is the configured response channel). On this host every cold round-trip costs
 * seconds, so halving them halves the delay before the indicator appears.
 *
 * Never throws: a typing indicator is cosmetic, so any failure is reported via the result.
 */
export async function sendTyping(client: Client, channelId: string | null | undefined): Promise<SendTypingResult> {
  if (!channelId) return { ok: false, reason: "no-channel" };

  try {
    await client.rest.post(Routes.channelTyping(channelId));
    return { ok: true };
  } catch {
    return { ok: false, reason: "error" };
  }
}

export type TypingLoopOptions = {
  /** Channel to type in, resolved per send so a config change is picked up without a restart. */
  channelId: () => string | null | undefined;
  /** Called on every tick and every poke: true while the indicator should be visible. */
  isActive: () => boolean;
  /** Override the actual send (tests). Defaults to `sendTyping(client, id)`. */
  send?: (channelId: string) => Promise<SendTypingResult>;
  intervalMs?: number;
  now?: () => number;
};

export type TypingIndicator = {
  /** Stop the loop. Safe to call twice. */
  stop: () => void;
  /**
   * Re-evaluate immediately. Call this when `isActive()` may have just flipped to true
   * (a message entered the queue) so the indicator appears without waiting up to
   * `intervalMs` for the next tick.
   */
  poke: () => void;
};

/**
 * Keeps the typing indicator alive every `intervalMs` (default 8s) for as long as
 * `isActive()` reports work in the queue. When inactive, nothing is sent.
 */
export function startTypingLoop(client: Client, options: TypingLoopOptions): TypingIndicator {
  const intervalMs = options.intervalMs ?? TYPING_INTERVAL_MS;
  const now = options.now ?? Date.now;
  const send = options.send ?? ((channelId: string) => sendTyping(client, channelId));

  let lastSentAt = 0;
  let lastErrorLoggedAt = 0;
  let stopped = false;

  const attempt = (minGapMs: number): void => {
    if (stopped) return;
    let active: boolean;
    try {
      active = options.isActive();
    } catch (error) {
      console.error(`[TYPING] isActive() failed: ${String((error as Error)?.message ?? error)}`);
      return;
    }
    if (!active) return;

    const at = now();
    if (at - lastSentAt < minGapMs) return;

    const channelId = options.channelId();
    if (!channelId) return;

    lastSentAt = at;
    void send(channelId)
      .then((result) => {
        if (result.ok) return;
        // A failing channel (no permission, deleted, rate limited) must not spam the log.
        if (at - lastErrorLoggedAt < TYPING_ERROR_LOG_COOLDOWN_MS) return;
        lastErrorLoggedAt = at;
        console.warn(`[TYPING] Could not show typing indicator in ${channelId} (${result.reason ?? "unknown"})`);
      })
      // Nothing awaits this promise, so a rejection here would become an unhandled
      // rejection and take the process down. The indicator is cosmetic: swallow it.
      .catch((error) => {
        if (at - lastErrorLoggedAt < TYPING_ERROR_LOG_COOLDOWN_MS) return;
        lastErrorLoggedAt = at;
        console.warn(`[TYPING] sendTyping threw: ${String((error as Error)?.message ?? error)}`);
      });
  };

  const timer = setInterval(() => attempt(0), intervalMs);
  // The loop must not be the reason the process stays alive.
  timer.unref?.();

  return {
    stop: () => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
    },
    poke: () => attempt(TYPING_MIN_GAP_MS),
  };
}
