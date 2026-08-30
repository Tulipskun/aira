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

const { parseIslaReply, ISLA_REPLY_SCHEMA } = await import("../src/gemini/reply-format.js");

console.log("=== 1. well-formed replies ===");
const ok = parseIslaReply('{"Isla":"ไอล่าตอบกลับค่ะ","summery":"ผู้ใช้สวัสดีและไอล่าตอบกลับ"}');
check("isla extracted", ok.isla === "ไอล่าตอบกลับค่ะ" && ok.parsed === true);
check("summery extracted", ok.summery === "ผู้ใช้สวัสดีและไอล่าตอบกลับ");
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
check("extra keys ignored", parseIslaReply('{"Isla":"ค่ะ","summery":"ส","mood":"happy"}').parsed === true);
check("brace inside a string value is safe", parseIslaReply('{"Isla":"มี } กับ { ค่ะ","summery":"ส"}').isla === "มี } กับ { ค่ะ");
check("quote escaped inside value is safe", parseIslaReply('{"Isla":"\\"ขอบคุณค่ะ\\"","summery":"ส"}').isla === '"ขอบคุณค่ะ"');
check("whitespace padded", parseIslaReply('  \n {"Isla":"ค่ะ","summery":"ส"} \n ').parsed === true);
check("summery missing still parses", (() => { const r = parseIslaReply('{"Isla":"ค่ะ"}'); return r.parsed === true && r.isla === "ค่ะ" && r.summery === ""; })());

console.log("=== 3. fallback: never lose the user's reply ===");
const plain = parseIslaReply("สวัสดีค่ะ คุณ Yuuta");
check("plain text becomes isla", plain.isla === "สวัสดีค่ะ คุณ Yuuta");
check("plain text flagged unparsed", plain.parsed === false && plain.summery === "");
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

console.log("=== 4. schema shape ===");
check("schema requires both keys", ISLA_REPLY_SCHEMA.required.includes("Isla") && ISLA_REPLY_SCHEMA.required.includes("summery"));
check("schema has exactly the two documented keys", Object.keys(ISLA_REPLY_SCHEMA.properties).join(",") === "Isla,summery");
check("schema is JSON-serialisable", (() => { JSON.stringify(ISLA_REPLY_SCHEMA); return true; })());

// ---------------------------------------------------------------- DB round-trip
const { saveMessage, getHistory, listMessages, closeHistoryDb } = await import("../src/sql/history.js");

console.log("=== 5. summery is stored beside the reply, not inside it ===");
saveMessage({ role: "user", userId: "u1", user: "Yuuta", text: "สวัสดี", timestamp: "2026-01-01T00:00:00.000Z" });
saveMessage({ role: "model", text: "สวัสดีค่ะ", summary: "ผู้ใช้สวัสดีและไอล่าตอบกลับ", timestamp: "2026-01-01T00:00:05.000Z" });
saveMessage({ role: "model", text: "ไม่มีสรุป", timestamp: "2026-01-01T00:00:09.000Z" });
const rows = getHistory(50);
check("history round-trips summary", rows[1].summary === "ผู้ใช้สวัสดีและไอล่าตอบกลับ");
check("model text holds only the reply", rows[1].text === "สวัสดีค่ะ" && !rows[1].text.includes("summery"));
check("absent summary is null, not undefined-crash", rows[2].summary === null);
check("user rows carry no summary", rows[0].summary === null);
check("listMessages also exposes summary", listMessages({ limit: 3 })[1].summary === "ผู้ใช้สวัสดีและไอล่าตอบกลับ");
closeHistoryDb();

console.log("=== 6. existing databases get the column (lazy migration) ===");
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
const old = mod.getHistory(10);
check("old row still readable after migration", old.length === 1 && old[0].text === "ของเก่า");
check("old row summary is null", old[0].summary === null);
mod.saveMessage({ role: "model", text: "ใหม่", summary: "สรุปใหม่", timestamp: "2025-01-02T00:00:00.000Z" });
check("new write works on migrated table", mod.getHistory(10)[1].summary === "สรุปใหม่");
mod.closeHistoryDb();

rmSync(dir, { recursive: true, force: true });
console.log(fail ? `\n❌ ${fail} FAILED — ${pass} passed` : `\n✅ ALL PASS — ${pass} passed, 0 failed`);
process.exit(fail ? 1 : 0);
