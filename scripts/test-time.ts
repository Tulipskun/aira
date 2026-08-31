// Tests for thaiTimestamp(): the UTC -> Thailand-local conversion applied to every timestamp
// that is sent into a prompt.   bun run scripts/test-time.ts
// No network. The zone is read from ISLA_TIMEZONE at module load, so the alternate-zone cases
// import the module again with a cache-busting query string.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let pass = 0;
let fail = 0;
function check(label: string, cond: boolean, detail = ""): void {
  console.log(`  ${cond ? "✅" : "❌"} ${label}${cond ? "" : detail ? ` — ${detail}` : ""}`);
  cond ? pass++ : fail++;
}

const dir = mkdtempSync(join(tmpdir(), "aira-time-test-"));
process.env.SQLITE_PATH = join(dir, "test.db");

const { thaiTimestamp, TIMEZONE_LABEL } = await import("../src/gemini/time.js");

console.log("=== 1. default zone is Thailand ===");
check("zone defaults to Asia/Bangkok", TIMEZONE_LABEL === "Asia/Bangkok", TIMEZONE_LABEL);

// 20:01:47 UTC == 03:01:47 next day in Bangkok (+7, no DST).
const iso = "2026-08-30T20:01:47.957Z";
const out = thaiTimestamp(iso);
check("renders Bangkok wall clock", out.startsWith("2026-08-31T03:01:47"), out);
check("date rolls over correctly", out.startsWith("2026-08-31"), out);
check("keeps explicit +07:00 offset", out.endsWith("+07:00"), out);
check("drops milliseconds", /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+07:00$/.test(out), out);
check("is itself parseable by Date", !Number.isNaN(new Date(out).getTime()));
check("same instant after round-trip", new Date(out).getTime() === new Date(iso).getTime() - 957);

console.log("=== 2. the instant is preserved, only the rendering changes ===");
const midnightUtc = thaiTimestamp("2027-01-01T00:00:00.000Z");
check("00:00Z -> 07:00 ICT same day", midnightUtc === "2027-01-01T07:00:00+07:00", midnightUtc);
const lateUtc = thaiTimestamp("2026-12-31T18:30:00.000Z");
check("18:30Z -> 01:30 ICT next year", lateUtc === "2027-01-01T01:30:00+07:00", lateUtc);
const localNoZone = thaiTimestamp("2026-08-31T03:01:47+07:00");
check("already-Thai input is unchanged", localNoZone === "2026-08-31T03:01:47+07:00", localNoZone);

console.log("=== 3. garbage passes through instead of becoming 'Invalid Date' ===");
check("empty string stays empty", thaiTimestamp("") === "");
check("null -> empty", thaiTimestamp(null) === "");
check("undefined -> empty", thaiTimestamp(undefined) === "");
check("not-a-date returned as-is", thaiTimestamp("เมื่อวาน") === "เมื่อวาน", thaiTimestamp("เมื่อวาน"));
check("empty-ish junk returned as-is", thaiTimestamp("nonsense") === "nonsense");
check("never contains Invalid", ![thaiTimestamp(""), thaiTimestamp("x"), thaiTimestamp(iso)].some((v) => v.includes("Invalid")));

console.log("=== 4. offset comes from Intl, not a hardcoded +7 ===");
// Kolkata is +05:30 — a half-hour offset, which a naive "+07:00" constant could never produce.
const { createTimestampFormatter } = await import("../src/gemini/time.js");
const kolkata = createTimestampFormatter("Asia/Kolkata");
check("Asia/Kolkata renders +05:30", kolkata(iso) === "2026-08-31T01:31:47+05:30", kolkata(iso));

const asUtc = createTimestampFormatter("UTC");
check("UTC zone renders +00:00", asUtc(iso) === "2026-08-30T20:01:47+00:00", asUtc(iso));

const newYork = createTimestampFormatter("America/New_York");
const n = newYork("2026-08-30T20:01:47.000Z");
check("negative offset keeps its sign", n === "2026-08-30T16:01:47-04:00", n);

console.log("=== 5. midnight hourCycle guard (some ICU builds emit '24') ===");
const noon = thaiTimestamp("2026-08-30T17:00:00.000Z"); // 00:00 ICT
check("midnight renders 00, never 24", noon === "2026-08-31T00:00:00+07:00", noon);
check("no 'T24:' anywhere", !noon.includes("T24:"));

console.log("=== 6. wiring: what actually reaches the model ===");
// messageStep() is private, but ctxWindowCreate + the payload builder are not: assert through the
// same path the request uses by asking for the steps the pipeline would send.
const { ctxWindowCreate } = await import("../src/gemini/client.js");
const req = ctxWindowCreate(
  [{ role: "model", text: "ตอบกลับ", timestamp: "2026-08-30T20:01:47.957Z" }],
  "สวัสดีครับ", "Yuuta", "2026-08-30T20:02:00.000Z", undefined, [], "u1",
);
check("ctxWindowCreate keeps the raw UTC value on the Message (conversion happens at the step)", req.messages.at(-1)!.timestamp === "2026-08-30T20:02:00.000Z");
check("history rows are not mutated either", req.messages[0]!.timestamp === "2026-08-30T20:01:47.957Z");

console.log("=== 7. storage must stay UTC (the point of the split) ===");
process.env.SQLITE_PATH = join(mkdtempSync(join(tmpdir(), "aira-time-")), "t.db");
const { saveMessage, getHistory } = await import("../src/sql/history.js");
const stored = "2026-08-30T20:01:47.957Z";
saveMessage({ role: "user", userId: "u1", user: "Yuuta", text: "hi", timestamp: stored });
const row = getHistory(5)[0];
check("DB still stores UTC, untouched by the display conversion", row.timestamp === stored, row.timestamp);

console.log("=== 8. currentTimeBlock(): the per-turn <current_time> anchor ===");
const { currentTimeBlock, thaiNow } = await import("../src/gemini/time.js");
// The real bug this guards against: Yuuta typed "ยังไม่เที่ยงเลย" at 12:46:39+07:00 — 46 seconds
// past noon — and Isla believed him, because nothing in the prompt ranked the timestamp above a
// user's claim. The block must therefore carry the *exact* wall clock the rule in isla.md cites.
const noonPlus46 = currentTimeBlock(new Date("2026-08-31T05:46:39.000Z")); // 12:46:39 ICT
check("wrapped in <current_time> tags", noonPlus46 === "<current_time>2026-08-31T12:46:39+07:00</current_time>", noonPlus46);
check("same renderer as every other prompt timestamp", noonPlus46.includes(thaiTimestamp("2026-08-31T05:46:39.000Z")));
check("no milliseconds — matches the format the prompt teaches", /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+07:00$/.test(noonPlus46.slice(14, -15)), noonPlus46);
check("defaults to the real clock", currentTimeBlock() === `<current_time>${thaiNow()}</current_time>`, currentTimeBlock());
check("thaiNow is parseable as an instant", !Number.isNaN(new Date(thaiNow()).getTime()));
// A forged claim must not be able to look like this block: the value comes from the server clock,
// so assert the block is a *single* line the model cannot extend from message text.
check("one line, no nested tags a message could imitate", !/\n/.test(noonPlus46) && (noonPlus46.match(/</g) ?? []).length === 2);

console.log("=== 9. wiring: Gemini 1 gets the block, Gemini 2 does not ===");
const pipelineSrc = readFileSync("src/pipeline/pipeline.ts", "utf8");
const gemini1Call = /const response1 = await sendRequestGemini\(request1, \{[\s\S]*?\n  \}\);/.exec(pipelineSrc)?.[0] ?? "";
check("Gemini 1 systemInstruction ends with currentTimeBlock()", gemini1Call.includes("${currentTimeBlock()}"), gemini1Call.slice(0, 160));
const gemini2Call = /const result = await sendRequestGemini\(request,[\s\S]*?\n  \}\);/.exec(pipelineSrc)?.[0] ?? "";
check("Gemini 2 systemInstruction is unchanged (cacheable, no per-turn clock)", gemini2Call.includes("systemInstruction: gemini2SystemPrompt") && !gemini2Call.includes("currentTimeBlock"), gemini2Call.slice(0, 160));
const promptSrc = readFileSync("src/gemini/prompts/isla.md", "utf8");
check("the prompt actually tells her the precedence rule", promptSrc.includes("เชื่อถือได้มากกว่า") && promptSrc.includes("<current_time>"));
check("and gives the noon example verbatim", promptSrc.includes("ยังไม่เที่ยงเลย") && promptSrc.includes("12:46+07:00"));
check("still forbids breaking character to say so", promptSrc.includes("ห้ามบอกว่ากำลังตรวจข้อมูล"));

console.log("");
if (fail) { console.log(`❌ ${fail} FAILED, ${pass} passed`); process.exit(1); }
console.log(`✅ ALL PASS — ${pass} passed, 0 failed`);
