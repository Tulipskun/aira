import { strict as assert } from "node:assert";
import { waitForBotReady } from "./start-readiness.js";

let probes = 0;
const ready = await waitForBotReady(
  async () => {
    probes += 1;
    return probes >= 3;
  },
  () => true,
  { timeoutMs: 1_000, intervalMs: 1 },
);
assert.deepEqual(ready, { ready: true, reason: "ready" });
assert.equal(probes, 3);

const exited = await waitForBotReady(
  async () => false,
  () => false,
  { timeoutMs: 1_000, intervalMs: 1 },
);
assert.deepEqual(exited, { ready: false, reason: "exited" });

const timeout = await waitForBotReady(
  async () => false,
  () => true,
  { timeoutMs: 5, intervalMs: 1 },
);
assert.deepEqual(timeout, { ready: false, reason: "timeout" });

console.log("startup readiness tests: OK");
