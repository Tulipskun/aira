export type StartupResult =
  | { ready: true; reason: "ready" }
  | { ready: false; reason: "exited" | "timeout" };

export type StartupOptions = {
  timeoutMs?: number;
  intervalMs?: number;
};

export async function waitForBotReady(
  probe: () => Promise<boolean>,
  isProcessRunning: () => boolean,
  options: StartupOptions = {},
): Promise<StartupResult> {
  const timeoutMs = options.timeoutMs ?? 120_000;
  const intervalMs = options.intervalMs ?? 250;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (!isProcessRunning()) return { ready: false, reason: "exited" };
    if (await probe()) return { ready: true, reason: "ready" };
    await Bun.sleep(intervalMs);
  }

  if (!isProcessRunning()) return { ready: false, reason: "exited" };
  return { ready: false, reason: "timeout" };
}
