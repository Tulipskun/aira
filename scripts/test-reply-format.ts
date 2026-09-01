// Tests for Gemini 1's JSON reply contract: { Isla, summery }.
//   bun run scripts/test-reply-format.ts
// No network: parseIslaReply is pure, and the DB cases use a throwaway SQLite file.

import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let pass = 0;
let fail = 0;
function check(label: string, cond: boolean): void {
  console.log(`  ${cond ? "✅" : "❌"} ${label}`);
  cond ? pass++ : fail++;
}

const dir = mkdtempSync(join(tmpdir(), "aira-reply-test-"));
process.env.SQLITE_PATH = join(dir, "test.db");

const { parseIslaReply, normalizeColor, ISLA_REPLY_SCHEMA, MAX_MOOD_CHARS } = await import("../src/gemini/reply-format.js");

console.log("=== 1. well-formed replies ===");
const ok = parseIslaReply('{"Isla":"ไอล่าตอบกลับค่ะ","summery":"ผู้ใช้สวัสดีและไอล่าตอบกลับ","mood":"ยินดี","color":"#F1C40F"}');
check("isla extracted", ok.isla === "ไอล่าตอบกลับค่ะ" && ok.parsed === true);
check("summery extracted", ok.summery === "ผู้ใช้สวัสดีและไอล่าตอบกลับ");
check("mood extracted", ok.mood === "ยินดี");
check("color extracted as RGB int", ok.color === 0xf1c40f);
check("colorText kept verbatim for logs", ok.colorText === "#F1C40F");
check("no raw JSON leaks into isla", !ok.isla.includes("{") && !ok.isla.includes("Isla"));

const multiline = parseIslaReply('{"Isla":"สวัสดีค่ะ\\n(ไอล่ายิ้ม)\\nยินดีนะคะ","summery":"ทักทาย"}');
check("escaped newlines preserved", multiline.isla === "สวัสดีค่ะ\n(ไอล่ายิ้ม)\nยินดีนะคะ");

console.log("=== 2. tolerant of format drift ===");
check("code fence stripped", parseIslaReply('```json\n{"Isla":"ค่ะ","summery":"ส"}\n```').parsed === true);
check("prose before the object ignored", parseIslaReply('ได้เลยค่ะ:\n{"Isla":"ค่ะ","summery":"ส"}').isla === "ค่ะ");
check("prose after the object ignored", parseIslaReply('{"Isla":"ค่ะ","summery":"ส"}\nหวังว่าชอบนะคะ').isla === "ค่ะ");
check("lower-case key accepted", parseIslaReply('{"isla":"ค่ะ","summery":"ส"}').isla === "ค่ะ");
check("misspelt summary accepted", parseIslaReply('{"Isla":"ค่ะ","summary":"ส"}').summery === "ส");
check("reply/message aliases accepted", parseIslaReply('{"reply":"ค่ะ"}').isla === "ค่ะ" && parseIslaReply('{"message":"ค่ะ"}').isla === "ค่ะ");
check("extra keys ignored", parseIslaReply('{"Isla":"ค่ะ","summery":"ส","junk":"x"}').parsed === true);
check("mood key aliases accepted", parseIslaReply('{"Isla":"ค่ะ","emotion":"อาย"}').mood === "อาย" && parseIslaReply('{"Isla":"ค่ะ","feeling":"งอน"}').mood === "งอน");
check("colour (British spelling) accepted", parseIslaReply('{"Isla":"ค่ะ","colour":"#E91E63"}').color === 0xe91e63);
check("brace inside a string value is safe", parseIslaReply('{"Isla":"มี } กับ { ค่ะ","summery":"ส"}').isla === "มี } กับ { ค่ะ");
check("quote escaped inside value is safe", parseIslaReply('{"Isla":"\\"ขอบคุณค่ะ\\"","summery":"ส"}').isla === '"ขอบคุณค่ะ"');
check("whitespace padded", parseIslaReply('  \n {"Isla":"ค่ะ","summery":"ส"} \n ').parsed === true);
check("summery missing still parses", (() => { const r = parseIslaReply('{"Isla":"ค่ะ"}'); return r.parsed === true && r.isla === "ค่ะ" && r.summery === ""; })());
check("mood missing still parses", (() => { const r = parseIslaReply('{"Isla":"ค่ะ"}'); return r.parsed === true && r.mood === "" && r.color === undefined; })());
// mood is free text from the model; the footer has a hard budget, so overlong is clipped, not dropped.
check("overlong mood clipped to footer budget", (() => {
  const r = parseIslaReply(`{"Isla":"ค่ะ","mood":"${"อารมณ์".repeat(40)}"}`);
  return r.mood.length <= MAX_MOOD_CHARS && r.mood.length >= MAX_MOOD_CHARS - 3 && r.mood.startsWith("อารมณ์");
})());
// Clipping must not leave a Thai tone/vowel mark orphaned at the end (it renders as a floating box).
check("clip never orphans a thai mark", (() => {
  const r = parseIslaReply(`{"Isla":"ค่ะ","mood":"${"อารมณ์".repeat(40)}"}`);
  return !/[\u0E31\u0E34-\u0E3A\u0E47-\u0E4E]$/.test(r.mood);
})());
check("short mood untouched", parseIslaReply('{"Isla":"ค่ะ","mood":"อาย"}').mood === "อาย");

console.log("=== 3. fallback: never lose the user's reply ===");
const plain = parseIslaReply("สวัสดีค่ะ คุณ Yuuta");
check("plain text becomes isla", plain.isla === "สวัสดีค่ะ คุณ Yuuta");
check("plain text flagged unparsed", plain.parsed === false && plain.summery === "" && plain.mood === "" && plain.color === undefined);
const broken = parseIslaReply('{"Isla":"ค่ะ"');
check("truncated JSON falls back to raw text", broken.parsed === false && broken.isla === '{"Isla":"ค่ะ"');
check("empty input yields empty isla", parseIslaReply("").isla === "" && parseIslaReply("").parsed === false);
check("undefined input is safe", parseIslaReply(undefined).isla === "" && parseIslaReply(null).isla === "");
// An array wrapper is not the requested shape, but the object inside it is unambiguous, so
// braceBlock() recovers it rather than throwing the reply away -- sending something beats
// degrading to raw JSON text.
check("array wrapper is unwrapped instead of lost", (() => { const r = parseIslaReply('[{"Isla":"ค่ะ","summery":"ส"}]'); return r.parsed === true && r.isla === "ค่ะ"; })());
check("bare array with no object falls back", parseIslaReply("[]").parsed === false);
check("object without isla falls back", parseIslaReply('{"summery":"อย่างเดียว"}').parsed === false);
check("empty isla string is not a reply", parseIslaReply('{"Isla":"","summery":"ส"}').parsed === false);
check("never throws", (() => { for (const junk of ["{", "}", "[]", '{"a":', "\n\n", "👍", '{"Isla":123}']) { try { parseIslaReply(junk); } catch { return false; } } return true; })());
check("non-string isla coerced", parseIslaReply('{"Isla":123}').isla === "123");

console.log("=== 4. normalizeColor(): whatever she wrote becomes a Discord colour ===");
check("#rrggbb", normalizeColor("#F1C40F") === 0xf1c40f);
check("no hash", normalizeColor("F1C40F") === 0xf1c40f);
check("lowercase", normalizeColor("#f1c40f") === 0xf1c40f);
check("0x prefix", normalizeColor("0x3498DB") === 0x3498db);
check("3-digit shorthand expanded", normalizeColor("#abc") === 0xaabbcc);
check("8-digit hex drops alpha", normalizeColor("#1ABC9CFF") === 0x1abc9c);
check("rgb() accepted", normalizeColor("rgb(241, 196, 15)") === 0xf1c40f);
check("space-separated rgb() accepted", normalizeColor("rgba(233 30 99 / 0.5)") === 0xe91e63);
check("english colour name", normalizeColor("pink") === 0xe91e63);
check("thai colour name", normalizeColor("ชมพู") === 0xe91e63);
check("numeric JSON value read as decimal int", normalizeColor(15844367) === 0xf1c40f);
check("numeric value out of range rejected", normalizeColor(99999999) === undefined);
check("junk rejected", normalizeColor("สีแดงสดใส") === undefined);
check("empty rejected", normalizeColor("") === undefined && normalizeColor("  ") === undefined);
check("null/undefined safe", normalizeColor(null) === undefined && normalizeColor(undefined) === undefined);
check("partial hex rejected", normalizeColor("#12345") === undefined);
check("NaN-ish string rejected", normalizeColor("#GGHHII") === undefined);
// A colour of 0x000000 is legitimate black, so "no colour" must be undefined, never 0.
check("black is a colour, not an absence", normalizeColor("#000000") === 0);

console.log("=== 5. schema shape ===");
check("schema requires exactly the four keys, in order", ISLA_REPLY_SCHEMA.required.join(",") === "Isla,summery,mood,color");
check("schema has exactly the four documented keys", Object.keys(ISLA_REPLY_SCHEMA.properties).join(",") === "Isla,summery,mood,color");
check("mood/color are described in Thai so she answers in kind", (() => {
  const mood = ISLA_REPLY_SCHEMA.properties.mood.description;
  const color = ISLA_REPLY_SCHEMA.properties.color.description;
  return mood.includes("ภาษาไทย") && color.includes("hex") && color.includes("#");
})());
check("schema is JSON-serialisable", (() => { JSON.stringify(ISLA_REPLY_SCHEMA); return true; })());

// ---------------------------------------------------------------- DB round-trip
const { saveMessage, getHistory, listMessages, closeHistoryDb } = await import("../src/sql/history.js");

console.log("=== 6. summery is stored beside the reply, not inside it ===");
saveMessage({ role: "user", userId: "u1", user: "Yuuta", text: "สวัสดี", timestamp: "2026-01-01T00:00:00.000Z", sessionKey: "user:u1" });
saveMessage({ role: "model", text: "สวัสดีค่ะ", summary: "ผู้ใช้สวัสดีและไอล่าตอบกลับ", timestamp: "2026-01-01T00:00:05.000Z", sessionKey: "user:u1" });
saveMessage({ role: "model", text: "ไม่มีสรุป", timestamp: "2026-01-01T00:00:09.000Z", sessionKey: "user:u1" });
const rows = getHistory(50, "user:u1");
check("history round-trips summary", rows[1].summary === "ผู้ใช้สวัสดีและไอล่าตอบกลับ");
check("model text holds only the reply", rows[1].text === "สวัสดีค่ะ" && !rows[1].text.includes("summery"));
check("absent summary is null, not undefined-crash", rows[2].summary === null);
check("user rows carry no summary", rows[0].summary === null);
check("listMessages also exposes summary", listMessages({ limit: 3 })[1].summary === "ผู้ใช้สวัสดีและไอล่าตอบกลับ");
closeHistoryDb();

console.log("=== 7. existing databases get the columns (lazy migration) ===");
const { Database } = await import("bun:sqlite");
const legacy = join(dir, "legacy.db");
const raw = new Database(legacy);
raw.run(`CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  role TEXT NOT NULL CHECK (role IN ('user', 'model')),
  user_id TEXT, user_name TEXT, text TEXT NOT NULL, timestamp TEXT NOT NULL, file_name TEXT
)`);
raw.run(`INSERT INTO messages (role, user_id, user_name, text, timestamp) VALUES ('model', NULL, NULL, 'ของเก่า', '2025-01-01T00:00:00.000Z')`);
raw.close();
process.env.SQLITE_PATH = legacy;
const mod = await import(`../src/sql/history.js?legacy=${Date.now()}`);
const old = mod.getHistory(10, mod.LEGACY_SESSION_KEY);
check("old row still readable after migration", old.length === 1 && old[0].text === "ของเก่า");
check("old row summary is null", old[0].summary === null);
mod.saveMessage({ role: "model", text: "ใหม่", summary: "สรุปใหม่", timestamp: "2025-01-02T00:00:00.000Z", sessionKey: "user:u1" });
const mine = mod.getHistory(10, "user:u1");
check("new write works on migrated table", mine.length === 1 && mine[0].summary === "สรุปใหม่");
// The point of the session column: an unattributable legacy row stays out of a real user's window
// rather than being handed to whoever asks first.
check("legacy row is NOT visible in user:u1's history", !mine.some((r: { text: string }) => r.text === "ของเก่า"));
check("and the legacy read does not see the new row", mod.getHistory(10, mod.LEGACY_SESSION_KEY).length === 1);
mod.closeHistoryDb();

rmSync(dir, { recursive: true, force: true });
console.log(fail ? `\n❌ ${fail} FAILED — ${pass} passed` : `\n✅ ALL PASS — ${pass} passed, 0 failed`);
process.exit(fail ? 1 : 0);
