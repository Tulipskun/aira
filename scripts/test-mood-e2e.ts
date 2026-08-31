/**
 * Live proof that Gemini 1 really produces mood + color and that they reach a Discord embed.
 *   bun run scripts/test-mood-e2e.ts
 *
 * SPENDS REAL API QUOTA (2 full pipeline turns) — not part of the offline suite. Isolation is the
 * same as test-profile-e2e.ts: throwaway SQLite file, throwaway Chroma collection, its own payload
 * dump. The real DB is read before/after to prove nothing outside the temp dir changed.
 *
 * Why this exists at all: parseIslaReply() and buildReplyPayload() are covered offline, but the
 * offline tests feed them strings I wrote. Only a live turn shows whether the model actually
 * answers with a usable Thai mood and a real hex colour — the exact class of bug where the schema
 * asks for something and the model quietly sends `{}` (see OPERATION_ARGS_SCHEMA).
 *
 *   1. processMessage() returns a Thai mood and a 24-bit colour.
 *   2. The dumped Gemini 1 request really carries the mood/color instructions.
 *   3. The dumped response carries both keys in JSON.
 *   4. buildReplyPayload() turns them into the footer's mood line + embed colour + timestamp.
 *   5. mood is NOT written into the reply text (footer only) and the real DB is untouched.
 */
import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";

let pass = 0;
let fail = 0;
function check(label: string, cond: boolean, detail = ""): void {
  console.log(`  ${cond ? "✅" : "❌"} ${label}${cond ? "" : detail ? ` — ${detail}` : ""}`);
  if (cond) pass++;
  else fail++;
}

const dir = mkdtempSync(join(tmpdir(), "aira-mood-e2e-"));
const REAL_DB = "./.aira/aira.db";
const realBefore = existsSync(REAL_DB)
  ? (new Database(REAL_DB, { readonly: true }).query("SELECT COUNT(*) c FROM messages").get() as { c: number }).c
  : null;

process.env.SQLITE_PATH = join(dir, "e2e.db");
process.env.CHROMA_COLLECTION = "aira_mood_e2e_test";
process.env.GEMINI_DEBUG_PAYLOAD = "1";
process.env.GEMINI_DEBUG_PAYLOAD_FILE = join(dir, "payload.json");

const { processMessage } = await import("../src/pipeline/pipeline.js");
const { buildReplyPayload } = await import("../src/bot/message-handler.js");
const footer = await import("../src/bot/embed-footer.js");
const { readDebugDump } = await import("../src/gemini/debug-dump.js");
const { deleteMemories } = await import("../src/memory/chroma.js");

const USER = "e2e-mood-user-1";
const THAI = /[\u0E00-\u0E7F]/;

const turns = [
  { text: "Yuuta: วันนี้ดีใจมากเลย ได้หยุดทั้งสัปดาห์!", expect: "turn 1" },
  { text: "Yuuta: แต่พอคิดอีกที... อีกหน่อยก็หยุดไม่ได้อยู่ดีเนอะ", expect: "turn 2" },
];

const results: Array<Awaited<ReturnType<typeof processMessage>>> = [];
for (const [index, turn] of turns.entries()) {
  console.log(`=== ${turn.expect}: processMessage() ===`);
  const result = await processMessage({
    userId: USER,
    user: "Yuuta",
    text: turn.text,
    timestamp: new Date().toISOString(),
  });
  results.push(result);
  check("got a reply", typeof result.text === "string" && result.text.length > 0, result.text);
  check(`mood present (${result.mood ?? "none"})`, typeof result.mood === "string" && result.mood.length > 0);
  check("mood is Thai text", !!result.mood && THAI.test(result.mood), result.mood);
  check("mood is short (1-3 words)", !!result.mood && result.mood.split(/\s+/).length <= 3 && result.mood.length <= 60, result.mood);
  check(`color is a number (${result.color})`, typeof result.color === "number" && Number.isInteger(result.color));
  check("color fits 24-bit RGB", typeof result.color === "number" && result.color >= 0 && result.color <= 0xffffff);
  check("mood did not leak into the reply text", !result.text.includes(result.mood ?? "\u0000IMPOSSIBLE"));
}

console.log("=== dumped request: she was actually told about mood/color ===");
const dump = readDebugDump().filter((record) => record.stage === "gemini1");
const request = dump.find((record) => record.event === "request");
const requestText = JSON.stringify(request?.payload ?? {});
check("a gemini1 request was dumped", !!request);
check("system instruction names `mood`", requestText.includes('"mood"') || requestText.includes("mood"));
check("system instruction names `color`", requestText.includes("color"));
check("instruction states the mood is her feeling in Thai", requestText.includes("อารมณ์ของไอล่า"));
check("instruction asks for a hex colour", requestText.includes("hex"));

console.log("=== dumped response: the model answered with both keys ===");
const response = dump.find((record) => record.event === "response");
const responseText = JSON.stringify(response?.response ?? "");
check("response carries a mood value", /mood/i.test(responseText));
check("response carries a hex colour", /#[0-9a-fA-F]{6}/.test(responseText));

console.log("=== buildReplyPayload(): footer + accent bar ===");
const last = results[results.length - 1];
const payload = buildReplyPayload({
  text: last.text,
  ...(last.mood ? { mood: last.mood } : {}),
  ...(last.color !== undefined ? { color: last.color } : {}),
  status: last.status,
});
const embed = (payload.embeds?.[0] as { data?: Record<string, unknown> }).data ?? {};
const footerText = (embed.footer as { text?: string }).text ?? "";
const [statusLine = "", moodLine = ""] = footerText.split("\n");
check(`embed colour = ${last.color}`, embed.color === last.color);
check(`footer บรรทัดสอง = "อารมณ์: ${last.mood}"`, moodLine === `อารมณ์: ${last.mood}`, footerText);
check("footer บรรทัดแรก = การ์ดความสัมพันธ์ (ชื่อ + สถานะ + xp)",
  statusLine.startsWith(last.status.userName?.slice(0, footer.MAX_NAME_CHARS) ?? "")
    && /\(.*\)/.test(statusLine) && String(last.status.xp).length > 0, statusLine);
check("การ์ดแสดงค่าที่เปลี่ยนในเทิร์นนี้ด้วย", statusLine.includes(`[${footer.xpDeltaText(last.status.xpDelta)}]`), statusLine);
check("ชื่อใน footer ไม่เกิน 12 ตัวอักษร", (statusLine.split(" ")[0] ?? "").length <= footer.MAX_NAME_CHARS, statusLine);
check("embed มี timestamp (ไม่ใช่ค่าคงที่ในโค้ด)", typeof embed.timestamp === "string" && Date.parse(String(embed.timestamp)) > 0, String(embed.timestamp));
check("description is still her reply", embed.description === last.text);

console.log("=== the real database was not touched ===");
if (realBefore !== null) {
  const realAfter = (new Database(REAL_DB, { readonly: true }).query("SELECT COUNT(*) c FROM messages").get() as { c: number }).c;
  check(`real messages rows ${realBefore} -> ${realAfter}`, realBefore === realAfter);
} else {
  check("real DB absent (nothing to touch)", true);
}

// Clean up the throwaway collection so repeated runs do not accumulate memories.
try {
  const ids = await deleteMemories({ userId: USER });
  check(`cleaned up test memories (${ids})`, true);
} catch (error) {
  check("cleanup skipped", false, String(error));
}

rmSync(dir, { recursive: true, force: true });
console.log(`\n${fail === 0 ? "✅" : "❌"} ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
