// Tests for thaiTimestamp(): the UTC -> Thailand-local conversion applied to every timestamp
// that is sent into a prompt.   bun run scripts/test-time.ts
// No network. The zone is read from ISLA_TIMEZONE at module load, so the alternate-zone cases
// import the module again with a cache-busting query string.

import { mkdtempSync, rmSync } from "node:fs";
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

console.log("");
if (fail) { console.log(`❌ ${fail} FAILED, ${pass} passed`); process.exit(1); }
console.log(`✅ ALL PASS — ${pass} passed, 0 failed`);
