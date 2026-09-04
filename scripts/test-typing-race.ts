import { startTypingLoop, type SendTypingResult } from "../src/bot/typing.js";

let pass = 0;
let fail = 0;

function check(label: string, condition: boolean): void {
  console.log(`${condition ? "✅" : "❌"} ${label}`);
  condition ? pass++ : fail++;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

console.log("=== typing/reply race regression ===");

const request = deferred<SendTypingResult>();
let sendCalls = 0;
let active = true;
let pauseResolved = false;

const loop = startTypingLoop({} as any, {
  channelId: () => "chan-race",
  isActive: () => active,
  send: async () => {
    sendCalls++;
    return request.promise;
  },
  intervalMs: 60_000,
});

loop.poke();
check("typing request started", sendCalls === 1);

const pause = (loop as any).pause as (() => Promise<void>) | undefined;
check("typing loop exposes an async pause barrier", typeof pause === "function");

if (pause) {
  active = false;
  const pausedPromise = pause().then(() => { pauseResolved = true; });

  await new Promise((resolve) => setTimeout(resolve, 10));
  check("pause waits for an in-flight typing request", pauseResolved === false);
  check("pause prevents a new typing request", sendCalls === 1);

  request.resolve({ ok: true });
  await pausedPromise;
  check("pause resolves after the typing request settles", pauseResolved === true);

  loop.stop();
}

console.log(`=== สรุป: ${pass} passed, ${fail} failed ===`);
if (fail) process.exit(1);
