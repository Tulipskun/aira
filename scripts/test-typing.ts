import { startTypingLoop, sendTyping, TYPING_INTERVAL_MS, type SendTypingResult } from "../src/bot/typing.js";

let pass = 0;
let fail = 0;
function check(label: string, cond: boolean): void {
  console.log(`  ${cond ? "✅" : "❌"} ${label}`);
  cond ? pass++ : fail++;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function fakeClock() {
  let t = 1_000_000;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

/** Collects sends without touching Discord. */
function recorder() {
  const sent: string[] = [];
  const send = async (channelId: string): Promise<SendTypingResult> => {
    sent.push(channelId);
    return { ok: true };
  };
  return { sent, send };
}

console.log(`TYPING_INTERVAL_MS = ${TYPING_INTERVAL_MS}`);
check("interval default is 8s", TYPING_INTERVAL_MS === 8_000);

console.log("=== 1. rising edge: poke when queue non-empty sends immediately ===");
{
  const clock = fakeClock();
  const { sent, send } = recorder();
  let active = false;
  const loop = startTypingLoop({} as any, {
    channelId: () => "chan-1",
    isActive: () => active,
    send,
    now: clock.now,
  });
  loop.poke();
  check("inactive -> ไม่ส่ง", sent.length === 0);
  active = true;
  loop.poke();
  check("active -> ส่งทันที 1 ครั้ง", sent.length === 1 && sent[0] === "chan-1");
  loop.poke();
  check("poke ซ้ำใน 1 วิ -> throttle ไม่ส่งซ้ำ", sent.length === 1);
  clock.advance(1_000);
  loop.poke();
  check("พ้น min-gap -> ส่งได้อีก", sent.length === 2);
  loop.stop();
}

console.log("=== 2. loop re-arms ทุก 8 วิ ตราบใดที่คิวยังมีของ ===");
{
  const clock = fakeClock();
  const { sent, send } = recorder();
  let active = true;
  const loop = startTypingLoop({} as any, {
    channelId: () => "chan-2",
    isActive: () => active,
    send,
    intervalMs: 40,          // scale down so the test is fast; logic is interval-agnostic
    now: clock.now,
  });
  const realSleep = sleep;
  await realSleep(150);
  check(`ส่งซ้ำเองได้ (ticks≈${sent.length} >= 3)`, sent.length >= 3);
  const before = sent.length;
  active = false;
  await realSleep(130);
  check("คิวว่าง -> หยุดส่ง", sent.length === before);
  active = true;
  await realSleep(130);
  check("กลับมามีของ -> ส่งต่อ", sent.length > before);
  loop.stop();
  const atStop = sent.length;
  await realSleep(130);
  check("stop() -> ไม่ส่งอีก", sent.length === atStop);
  loop.stop();
  check("stop() ซ้ำไม่ crash", true);
}

console.log("=== 3. ไม่มี channel / channel non-text -> ไม่ส่ง, ไม่ crash ===");
{
  const clock = fakeClock();
  const { sent, send } = recorder();
  let id: string | null = null;
  const loop = startTypingLoop({} as any, { channelId: () => id, isActive: () => true, send, now: clock.now });
  loop.poke();
  check("channelId null -> ไม่ส่ง", sent.length === 0);
  id = "chan-3";
  clock.advance(2_000);
  loop.poke();
  check("มี channel แล้ว -> ส่ง", sent.length === 1);
  loop.stop();
}

console.log("=== 4. send error -> ไม่ throw, log มี cooldown (ไม่ spam) ===");
{
  const clock = fakeClock();
  let calls = 0;
  const warns: string[] = [];
  const realWarn = console.warn;
  console.warn = (...a: any[]) => { warns.push(a.join(" ")); };
  const loop = startTypingLoop({} as any, {
    channelId: () => "bad-chan",
    isActive: () => true,
    send: async () => { calls++; return { ok: false, reason: "error" }; },
    now: clock.now,
  });
  loop.poke();
  clock.advance(2_000); loop.poke();
  clock.advance(2_000); loop.poke();
  await sleep(20);
  console.warn = realWarn;
  check(`ส่งซ้ำได้แต่ warn เพียงครั้งเดียว (calls=${calls}, warns=${warns.length})`, calls === 3 && warns.length === 1);
  check("ข้อความ warn ระบุ channel", warns[0]?.includes("bad-chan"));
  loop.stop();
}

console.log("=== 5. isActive() throw -> loop ไม่พัง ===");
{
  const clock = fakeClock();
  const { sent, send } = recorder();
  const realErr = console.error;
  const errs: string[] = [];
  console.error = (...a: any[]) => { errs.push(a.join(" ")); };
  let boom = true;
  const loop = startTypingLoop({} as any, {
    channelId: () => "chan-5",
    isActive: () => { if (boom) throw new Error("boom"); return true; },
    send,
    now: clock.now,
  });
  loop.poke();
  console.error = realErr;
  check("จับ error ได้ + log", sent.length === 0 && errs.length === 1);
  boom = false;
  clock.advance(2_000);
  loop.poke();
  check("หาย boom -> ทำงานต่อ", sent.length === 1);
  loop.stop();
}

console.log("=== 5b. send() reject -> loop ไม่พัง, log มี cooldown ===");
{
  const clock = fakeClock();
  const warns: string[] = [];
  const realWarn = console.warn;
  console.warn = (...a: any[]) => { warns.push(a.join(" ")); };
  const loop = startTypingLoop({} as any, {
    channelId: () => "reject-chan",
    isActive: () => true,
    send: async () => { throw new Error("rate limited"); },
    now: clock.now,
  });
  loop.poke();
  clock.advance(2_000); loop.poke();
  await sleep(20);
  console.warn = realWarn;
  check(`reject ถูกกลืน (warn ${warns.length} ครั้ง)`, warns.length === 1 && warns[0].includes("rate limited"));
  loop.stop();
}

console.log("=== 6. sendTyping() ยิง REST ตรง (mock client.rest) ===");
{
  const r5 = await sendTyping({ rest: { post: async () => ({}) } } as any, null);
  check("channelId null -> no-channel, ไม่ยิง REST", r5.ok === false && r5.reason === "no-channel");

  const calls: string[] = [];
  const ok = await sendTyping({ rest: { post: async (route: string) => { calls.push(route); return {}; } } } as any, "chan-1");
  check("ยิง POST /channels/:id/typing ครั้งเดียว", ok.ok === true && calls.length === 1 && calls[0] === "/channels/chan-1/typing");

  const fetched: string[] = [];
  const noFetch = await sendTyping({
    rest: { post: async () => ({}) },
    channels: { fetch: async (id: string) => { fetched.push(id); return { isTextBased: () => true, sendTyping: async () => {} }; } },
  } as any, "chan-2");
  check("ไม่เรียก channels.fetch() (ตัด round-trip)", noFetch.ok === true && fetched.length === 0);

  const err = await sendTyping({ rest: { post: async () => { throw new Error("403"); } } } as any, "chan-3");
  check("REST error -> ok=false ไม่ throw", err.ok === false && err.reason === "error");
}

console.log("=== 7. integration: loop + MessageScheduler จริง (wiring เดียวกับ bot.ts) ===");
{
  const { MessageScheduler } = await import("../src/pipeline/scheduler.js");
  // Private session per user (the default), so "ต่างผู้ใช้ -> pendingCount 2" still holds: the
  // scheduler batches on sessionKey, and user:<id> is unique per user until they join a group.
  const msg = (u: string, t: string) => ({ userId: u, user: u, text: t, timestamp: new Date().toISOString(), channelId: "c1", sessionKey: `user:${u}` });
  const busy: string[] = [];
  let inFlight = 0;
  let total = 0;
  const clock = fakeClock();
  const { sent, send } = recorder();

  const sched = new MessageScheduler({
    debounceMs: 60,
    maxWaitMs: 200,
    onFlush: async (messages) => {
      inFlight = Math.max(0, inFlight + 1);
      busy.push(`+${messages.length}`);
      typingLoop.poke();
      await sleep(40);
      total += messages.length;
      inFlight = Math.max(0, inFlight - 1);
      busy.push(`-${messages.length}`);
    },
  });
  const typingLoop = startTypingLoop({} as any, {
    channelId: () => "c1",
    isActive: () => inFlight > 0 || sched.hasPending(),
    send,
    intervalMs: 40,
    now: clock.now,
  });

  check("ว่างตอนแรก -> hasPending false", sched.hasPending() === false && sched.pendingCount() === 0);
  typingLoop.poke();
  check("คิวว่าง -> poke แล้วไม่ส่ง indicator", sent.length === 0);

  sched.push(msg("a", "hi"));
  typingLoop.poke();
  check("push -> hasPending true", sched.hasPending() === true);
  check("มีของในคิว -> ส่ง indicator ทันที", sent.length === 1);
  const duringQueue = sent.length;
  await sleep(130);
  check(`ระหว่าง debounce -> loop ต่ออายุเอง (+${sent.length - duringQueue})`, sent.length > duringQueue);

  sched.push(msg("a", "again"));
  check("ผู้ใช้เดิม -> pendingCount ยัง 1", sched.pendingCount() === 1);
  sched.push(msg("b", "yo"));
  check("ต่างผู้ใช้ -> pendingCount 2", sched.pendingCount() === 2);

  await sleep(400);
  check("หลัง flush -> คิวว่าง", sched.hasPending() === false);
  check("inFlight counter กลับ 0 (ไม่รั่ว)", inFlight === 0);
  // สอง flush ของต่างผู้ใช้ทำงานซ้อนกัน จึงเป็น +2,+1,-2,-1 ไม่ใช่สลับ +,-
  // นี่คือเหตุผลที่ bot.ts ใช้ตัวนับ ไม่ใช่ boolean
  const plus = busy.filter((x) => x.startsWith("+")).length;
  const minus = busy.filter((x) => x.startsWith("-")).length;
  // maxWaitMs ทำให้จำนวน flush ไม่ตายตัว จึงตรวจแค่ "สมดุล" (ทุก + มี - คู่กัน)
  check(`onBusy สมดุลทุกคู่ (${busy.join(",")} -> ${plus}+/ ${minus}-)`, busy.length >= 4 && plus === minus);
  check("ข้อความครบทุกชิ้นถูก flush", total === 3);

  const afterIdle = sent.length;
  await sleep(130);
  check("งานเสร็จ + คิวว่าง -> หยุดส่ง indicator", sent.length === afterIdle);

  sched.push(msg("c", "x"));
  sched.flushAll();
  check("flushAll -> คิวว่างทันที", sched.hasPending() === false);
  typingLoop.stop();
  await sleep(120);
  check("stop() แล้วไม่ส่งเพิ่ม", sent.length === afterIdle);
}

console.log(`\n=== สรุป: ${pass} passed, ${fail} failed ===`);
if (fail) process.exit(1);
