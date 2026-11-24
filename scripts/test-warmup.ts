import { warmDns, warmHttps, warmNetwork, WARM_HOSTS, WARM_URLS, type DnsWarmStats } from "../src/bot/warmup.js";

let pass = 0;
let fail = 0;
function check(label: string, cond: boolean): void {
  console.log(`  ${cond ? "✅" : "❌"} ${label}`);
  cond ? pass++ : fail++;
}

/** A resolver that stalls `stallCount` times (each ~5s of simulated cost) then goes fast. */
function fakeResolver(stallCount: number, costMs = 5_000) {
  const seen: string[] = [];
  let calls = 0;
  let clock = 0;
  const resolve = async (host: string) => {
    seen.push(host);
    calls++;
    // Advance the fake clock the way the real stall does; warmDns uses Date.now(), so we
    // measure by counting stalls instead of time when the clock is not injectable.
    clock += calls <= stallCount ? costMs : 10;
  };
  return { seen, resolve, get calls() { return calls; }, get clock() { return clock; } };
}

console.log("=== 1. warmDns: soak จนนิ่ง แล้วรายงาน stats ===");
{
  // Real 5s stalls are simulated by actually sleeping, so the >500ms threshold trips.
  const slow = (ms: number) => new Promise((r) => setTimeout(r, ms));
  let n = 0;
  const stats: DnsWarmStats = await warmDns(["a.test", "b.test", "c.test", "d.test"], async () => {
    n++;
    if (n <= 2) await slow(600); // two stalls
  });
  check("ดูด stall 2 ครั้ง", stats.stalls === 2);
  check("soak ต่อจนนิ่ง 2 ครั้งติด (4 lookups)", stats.lookups === 4 && n === 4);
  check("คืนเวลาที่ใช้รวม", stats.ms >= 1_200);

  let m = 0;
  const fast = await warmDns(["a.test", "b.test", "c.test", "d.test"], async () => { m++; });
  check("resolver นิ่งอยู่แล้ว -> 2 lookups, 0 stall", fast.stalls === 0 && fast.lookups === 2 && m === 2);
}

console.log("=== 2. warmDns: error ไม่ทำให้พัง (fire-and-forget ได้ปลอดภัย) ===");
{
  const seen: string[] = [];
  let threw = false;
  try {
    await warmDns(["a.test", "b.test", "c.test", "d.test"], async (host) => {
      seen.push(host);
      if (host === "b.test") throw new Error("ENOTFOUND");
    });
  } catch {
    threw = true;
  }
  check("host ที่ lookup ไม่ขึ้น -> ไม่ throw", !threw);
  check("ยัง soak ต่อจนครบเงื่อนไข", seen.length >= 2);
}

console.log("=== 3. warmDns: มีเพดานกัน hang ตลอดกาล ===");
{
  let calls = 0;
  const stats = await warmDns(["a.test"], async () => {
    calls++;
    await new Promise((r) => setTimeout(r, 550)); // never becomes stable
  });
  check("หยุดที่เพดาน 12 lookups แม้ไม่มีวันนิ่ง", calls === 12 && stats.lookups === 12);
  check("นับ stall ครบ 12 ครั้ง", stats.stalls === 12);
}

console.log("=== 4. warmHttps: ยิงทุก URL แบบขนาน และกลืน error ===");
{
  const hits: string[] = [];
  await warmHttps(["https://x.test/1", "https://x.test/2"], async (url) => { hits.push(url); });
  check("fetch ครบทุก url", hits.length === 2 && hits.includes("https://x.test/1"));

  let threw = false;
  try {
    await warmHttps(["https://dead.test"], async () => { throw new Error("ECONNREFUSED"); });
  } catch {
    threw = true;
  }
  check("fetch ล้มเหลว -> ไม่ throw", !threw);
  check("WARM_URLS ไม่มี API key/secret ปนใน query",
    WARM_URLS.every((u) => !/key=|token=|secret=/i.test(u)));
}

console.log("=== 5. warmNetwork: เปิด socket แล้ว drain stall วนจนนิ่ง ===");
{
  const order: string[] = [];
  const stats = await warmNetwork({
    hosts: ["h1.test", "h2.test", "h3.test"],
    urls: ["https://u1.test"],
    resolve: async (host) => { order.push(`dns:${host}`); },
    get: async (url) => { order.push(`http:${url}`); },
  });
  check("เริ่มด้วย fetch (socket) ก่อน แล้วจึง soak", order[0].startsWith("http:") && order[1].startsWith("dns:"));
  check("pass แรกนิ่ง -> หยุดที่ 2 lookups", stats.lookups === 2 && stats.stalls === 0);
  check("คืน stats (lookups/stalls/ms)", typeof stats.ms === "number" && stats.ms >= 0);
  check("WARM_HOSTS ขึ้นด้วย discord.com + generativelanguage",
    WARM_HOSTS[0] === "discord.com" && WARM_HOSTS[1] === "generativelanguage.googleapis.com");
}

console.log("=== 5b. warmNetwork: stall ที่โผล่หลัง fetch ต้องถูก drain ซ้ำ ===");
{
  // Models the measured behaviour: the concurrent HTTPS warm-up can re-arm a stall, so a
  // single soak pass is not enough — lookups 1 and 3 stall, and the pass must keep going.
  const slow = (ms: number) => new Promise((r) => setTimeout(r, ms));
  let httpCalls = 0;
  let dnsCalls = 0;
  const stats = await warmNetwork({
    hosts: ["a.test", "b.test", "c.test", "d.test", "e.test"],
    urls: ["https://x.test"],
    get: async () => { httpCalls++; },
    resolve: async () => { dnsCalls++; if (dnsCalls === 1 || dnsCalls === 3) await slow(600); },
  });
  check("pass แรกเจอ stall 2 ครั้ง", stats.stalls === 2);
  check("ทำ pass สองเพื่อพิสูจน์ว่านิ่งจริง", httpCalls === 2);
  check("lookups รวมมากกว่า 2 (มี drain ซ้ำ)", stats.lookups > 2);
}

console.log("=== 6. ของจริงบน host นี้: warmNetwork() ต้องดูด stall จนหมด ===");
{
  const { lookup } = await import("node:dns/promises");
  const timed = async (f: () => Promise<unknown>) => {
    const t0 = performance.now();
    await f();
    return performance.now() - t0;
  };
  const stats = await warmNetwork();
  const after = await timed(() => lookup("discord.com"));
  console.log(`     warmNetwork: ${stats.stalls} stall(s), ${stats.lookups} lookups, ${stats.ms}ms — lookup หลัง warm ${after.toFixed(0)}ms`);
  check("ดูด stall อย่างน้อย 1 ครั้ง (host นี้มีจริงเสมอ)", stats.stalls >= 1);
  check("warmNetwork เสร็จภายใน 40s (มีเพดานกัน hang)", stats.ms < 40_000);
  check("หลัง warm แล้ว lookup ต้องเร็ว (<1s)", after < 1_000);
}

console.log(`\n=== สรุป: ${pass} passed, ${fail} failed ===`);
if (fail) process.exit(1);
