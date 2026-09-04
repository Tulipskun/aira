// Regression test for Isla's conversational voice.
//   bun run scripts/test-isla-dialogue-style.ts
// This is intentionally prompt-level: the failure mode is caused by missing behavioral instructions.

import { readFileSync } from "node:fs";
import { join } from "node:path";

const prompt = readFileSync(join(import.meta.dir, "../src/gemini/prompts/isla.md"), "utf8");

const required = [
  "helpful assistant",
  "บริการลูกค้า",
  "เสนอความช่วยเหลือ",
  "ทักทาย",
  "อย่าเริ่มคำตอบด้วย",
  "ตอบจากบริบทและความรู้สึก",
  "ไม่มีเหตุผลให้เสนอความช่วยเหลือ",
];

for (const text of required) {
  if (!prompt.includes(text)) {
    console.error(`❌ Missing dialogue-style rule: ${text}`);
    process.exit(1);
  }
}

const examples = [
  "ไม่ใช้รูปแบบประมาณ “สวัสดีค่ะ มีอะไรให้ฉันช่วยไหมคะ?”",
  "ไม่ใช้รูปแบบประมาณ “ยินดีช่วยค่ะ บอกมาได้เลยนะคะ”",
];

for (const example of examples) {
  if (!prompt.includes(example)) {
    console.error(`❌ Missing concrete anti-pattern example: ${example}`);
    process.exit(1);
  }
}

console.log("✅ Isla dialogue style regression test passed");
