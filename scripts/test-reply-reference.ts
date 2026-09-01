/**
 * Offline tests for the reply reference (quote) path — no Discord calls, no Gemini quota.
 *
 * Why these exist: `reply.messageReference` is the only key discord.js v14 reads, and a wrong key
 * (`messageId`) sends the message with NO reference and NO error. So the tests assert the exact
 * shape that reaches `channel.send()`, plus that the reference survives the other spreads in
 * buildReplyPayload(), and that the scheduler really hands the flush handler the message ids.
 *
 *   bun run scripts/test-reply-reference.ts
 */
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ChannelType, Client, GatewayIntentBits, MessagePayload } from "discord.js";
import type { Message } from "discord.js";

const dir = mkdtempSync(join(tmpdir(), "aira-replyref-test-"));
// Importing message-handler pulls in the pipeline and the SQLite layer, which runs the
// user_profiles migration at module load. Point it at a throwaway database so a test run can
// never touch the bot's real history (this is the same guard test-media.ts uses).
process.env.SQLITE_PATH = join(dir, "test.db");

const {
  buildReplyPayload,
  replyAnchorOf,
  replyReference,
  textForModel,
  toScheduledMessage,
} = await import("../src/bot/message-handler.js");
const { MessageScheduler } = await import("../src/pipeline/scheduler.js");
const footer = await import("../src/bot/embed-footer.js");
const { BOND_NAMES, bondEmoji } = await import("../src/sql/bonds.js");
const bondsAll = BOND_NAMES as string[];
import type { ScheduledMessage } from "../src/pipeline/scheduler.js";

let pass = 0;
let fail = 0;
function check(label: string, cond: boolean, seen?: unknown): void {
  console.log(`  ${cond ? "✅" : "❌"} ${label}${cond || seen === undefined ? "" : ` -- got: ${JSON.stringify(seen)}`}`);
  cond ? pass++ : fail++;
}

console.log("=== 1. replyReference(): คีย์ที่ discord.js v14 อ่านจริง ===");
{
  const ref = replyReference("1234567890");
  check("มี `reply`", "reply" in ref);
  check("messageReference = id (ไม่ใช่ messageId)", JSON.stringify(ref) === '{"reply":{"messageReference":"1234567890","failIfNotExists":false}}');
  check("failIfNotExists=false -> ข้อความถูกลบไประหว่าง pipeline ยังไม่พัง",
    JSON.stringify(ref).includes('"failIfNotExists":false'));
  check("ไม่มีคีย์ต้องห้าม `messageId`", !JSON.stringify(ref).includes("messageId"));
  check("ไม่มีคีย์ต้องห้าม `message_id` (ของ REST raw)", !JSON.stringify(ref).includes("message_id"));

  // discord.js รับ MessageResolvable (string | Message) — เราส่งเป็น string snowflake
  const typed = replyReference("1");
  check("type ของ reply ผูกกับ messageReference", "messageReference" in typed.reply);

  check("undefined -> {} (ไม่ใส่ reply)", JSON.stringify(replyReference(undefined)) === "{}");
  check("id ว่าง -> {} (ของเก่า/เทสต์ที่ไม่มี message id)", JSON.stringify(replyReference("")) === "{}");
}

console.log("=== 2. buildReplyPayload(): reference รอดผ่าน spread ทุกตัว ===");
{
  const noImage = buildReplyPayload({ text: "สวัสดีค่ะ", replyTo: "111" });
  check("มี reply", "reply" in noImage);
  check("embed มีข้อความ", (noImage.embeds?.[0] as { data?: { description?: string } }).data?.description === "สวัสดีค่ะ");
  check("ไม่มี files", noImage.files === undefined);

  const buf = Buffer.from("fake-png-bytes");
  const withImage = buildReplyPayload({ text: "ดีใจค่ะ", image: { buffer: buf, name: "happy.png" }, replyTo: "222" });
  check("มี reply แม้มีรูป (spread files ไม่ทับ)", "reply" in withImage);
  check("files ยังอยู่", withImage.files?.length === 1);
  check("embed ชี้ attachment", (withImage.embeds?.[0] as { data?: { image?: { url?: string } } }).data?.image?.url === "attachment://happy.png");

  const empty = buildReplyPayload({ text: "", replyTo: "333" });
  check("ข้อความว่าง -> embed ไม่ใช่ '' (Discord ปฏิเสธ)", (empty.embeds?.[0] as { data?: { description?: string } }).data?.description === "…");
  check("ข้อความว่างก็ยัง quote", JSON.stringify(empty.reply) === JSON.stringify({ messageReference: "333", failIfNotExists: false }));

  const plain = buildReplyPayload({ text: "ไม่มี anchor" });
  check("ไม่มี replyTo -> ไม่มี reply key (ส่งเป็นข้อความธรรมดา)", !("reply" in plain));
}

console.log("=== 3. replyAnchorOf(): ตอบข้อความล่าสุดของคนเดียวกัน ===");
{
  const m = (id: string, userId: string): ScheduledMessage => ({
    userId, user: userId, text: `t-${id}`, timestamp: "2026-08-31T00:00:00.000Z", channelId: "chan", messageId: id,
  });

  check("batch ว่าง -> undefined", replyAnchorOf([]) === undefined);
  check("ข้อความเดียว -> id ของมัน", replyAnchorOf([m("a", "u1")]) === "a");
  check("หลายข้อความรวมกัน -> id ล่าสุด", replyAnchorOf([m("a", "u1"), m("b", "u1"), m("c", "u1")]) === "c");
  check("คนละ author ใน batch -> ไม่ anchor (กัน quote ผิดคน)",
    replyAnchorOf([m("a", "u1"), m("b", "u2")]) === undefined);
  check("batch ที่ไม่มี messageId (ของเก่า/เทสต์) -> undefined", replyAnchorOf([{
    userId: "u1", user: "u1", text: "hi", timestamp: "2026-08-31T00:00:00.000Z", channelId: "chan",
  }]) === undefined);
}

console.log("=== 4. toScheduledMessage(): เก็บ message id จาก Discord message ===");
{
  const fake = (over: Record<string, unknown>) => ({
    content: "hello",
    id: "msg-1",
    channelId: "chan-1",
    createdTimestamp: Date.parse("2026-08-31T06:00:00.000Z"),
    author: { id: "u1", displayName: "Yuuta", username: "yuuta" },
    member: { displayName: "Yuuta" },
    attachments: { first: () => undefined, values: () => [] },
    stickers: { values: () => [] },
    embeds: { values: () => [] },
    ...over,
  }) as never;

  check("messageId = message.id", toScheduledMessage(fake({}))?.messageId === "msg-1");
  check("channelId ยังอยู่", toScheduledMessage(fake({}))?.channelId === "chan-1");
  check("ข้อความว่าง+ไม่มี media -> null (ไม่เปลี่ยนพฤติกรรมเดิม)", toScheduledMessage(fake({ content: "  " })) === null);
  check("custom emoji เดียว -> มี scheduled message + messageId",
    toScheduledMessage(fake({ content: "<:DeepSeek:123456789012345678>" }))?.messageId === "msg-1");
}

console.log("=== 5. scheduler: messageId รอดผ่านคิวไปถึง onFlush ===");
{
  const flushed: ScheduledMessage[][] = [];
  const scheduler = new MessageScheduler({ debounceMs: 10, maxWaitMs: 50, onFlush: (msgs) => { flushed.push(msgs); } });
  scheduler.push({ userId: "u1", user: "Yuuta", text: "หนึ่ง", timestamp: "2026-08-31T00:00:00.000Z", channelId: "chan", messageId: "m1" });
  scheduler.push({ userId: "u1", user: "Yuuta", text: "สอง", timestamp: "2026-08-31T00:00:01.000Z", channelId: "chan", messageId: "m2" });
  check("ก่อน flush คิวมีของ", scheduler.hasPending());
  await new Promise((r) => setTimeout(r, 120));
  check("flush 1 ครั้ง", flushed.length === 1);
  check("ได้ 2 ข้อความ", flushed[0]?.length === 2);
  check("ids คงอยู่ตามลำดับ", JSON.stringify(flushed[0]?.map((x) => x.messageId)) === '["m1","m2"]');
  check("anchor ที่ handler จะใช้ = m2 (ล่าสุด)", replyAnchorOf(flushed[0] ?? []) === "m2");
  check("หลัง flush คิวว่าง", !scheduler.hasPending());
}

console.log("=== 6. เส้นทางการส่ง: payload ที่ channel.send ได้รับจริง ===");
{
  // จำลองสิ่งที่ createOnFlush ทำ: anchor (string|undefined) -> buildReplyPayload -> channel.send
  const sent: unknown[] = [];
  const fakeChannel = { send: async (payload: unknown) => { sent.push(payload); } };
  const batch: ScheduledMessage[] = [
    { userId: "u1", user: "Yuuta", text: "หนึ่ง", timestamp: "2026-08-31T00:00:00.000Z", channelId: "chan", messageId: "m1" },
    { userId: "u1", user: "Yuuta", text: "สอง", timestamp: "2026-08-31T00:00:01.000Z", channelId: "chan", messageId: "m2" },
  ];
  await fakeChannel.send(buildReplyPayload({ text: "ตอบค่ะ", replyTo: replyAnchorOf(batch) }));

  const payload = sent[0] as { reply?: { messageReference?: unknown } };
  check("channel.send ได้ reply.messageReference = m2", payload.reply?.messageReference === "m2");
}

console.log("=== 7. discord.js จริงแปลง replyReference() เป็น message_reference ===");
{
  // of-discord.js proof: นี่คือโค้ดที่ channel.send() เรียกจริง
  // resolveBody() ไม่ async (คืน this) — ต้องอ่าน p.body หลังเรียก
  const bodyOf = (options: Record<string, unknown>) => {
    const target = {
      isMessage: false,
      client: { options: { failIfNotExists: true, jsonTransformer: (x: unknown) => x } },
      messages: { resolveId: (x: unknown) => (typeof x === "string" ? x : null) },
    };
    const payload = new MessagePayload(target as never, options as never);
    payload.resolveBody();
    return (payload.body as { message_reference?: unknown }).message_reference ?? null;
  };

  const ref = replyReference("123");
  check("มี anchor -> message_reference ครบทั้ง 2 ฟิลด์",
    JSON.stringify(bodyOf({ content: "hi", ...ref })) === '{"message_id":"123","fail_if_not_exists":false}');
  check("ไม่มี anchor -> ไม่ส่ง message_reference", bodyOf({ content: "hi", ...replyReference(undefined) }) === null);
  // เคสนี้คือเหตุผลที่เทสต์นี้ถือกำเนิด: คีย์ผิดแบบที่ไลบรารีอื่นใช้ ส่งออกไปโดยไม่มี error
  check("คีย์ผิด `messageId` -> เงียบ (message_reference = null)",
    bodyOf({ content: "hi", reply: { messageId: "123", failIfNotExists: false } }) === null);
}

console.log("=== 8. mood/status → footer, color → เส้นสีของ embed ===");
{
  const dataOf = (options: Parameters<typeof buildReplyPayload>[0]) =>
    (buildReplyPayload(options).embeds?.[0] as { data?: Record<string, unknown> }).data ?? {};
  const footerOf = (options: Parameters<typeof buildReplyPayload>[0]) =>
    (dataOf(options).footer as { text?: string } | undefined)?.text;

  const mooded = dataOf({ text: "ยินดีต้อนรับค่ะ", mood: "ยินดี", color: 0xf1c40f });
  check("footer มีบรรทัดอารมณ์", (mooded.footer as { text?: string } | undefined)?.text === "อารมณ์: ยินดี");
  check("embed ได้สีเป็น number", mooded.color === 0xf1c40f);

  const plain = dataOf({ text: "ไม่มีอารมณ์" });
  check("ไม่มี mood และไม่มี status -> footer fallback", (plain.footer as { text?: string } | undefined)?.text === "Isla");
  check("ไม่มี color -> ไม่ส่ง color เลย (ให้ Discord ใช้สี default)", !("color" in plain));

  // สีดำสนิทคือสีที่ใช้ได้จริง ถ้าโค้ดเขียน `if (options.color)` ค่า 0 จะถูกทิ้งเงียบ ๆ
  const black = dataOf({ text: "เศร้า", color: 0x000000 });
  check("color = 0 (ดำ) ยังถูกส่ง", black.color === 0);

  const moodOnly = dataOf({ text: "งอน", mood: "งอน" });
  check("มี mood อย่างเดียวก็ยังตั้ง footer", (moodOnly.footer as { text?: string } | undefined)?.text === "อารมณ์: งอน");
  check("มี mood อย่างเดียว -> ไม่มี color key", !("color" in moodOnly));

  // การ์ดความสัมพันธ์เต็มรูปแบบ (ตัวอย่างที่เจ้าของรูปแบบกำหนด)
  const card = footerOf({
    text: "คิดถึงเหมือนกันนะคะ",
    mood: "สงบ",
    status: { userName: "Farris", bond: "lover", xp: 199, xpDelta: 12, nickname: ["คนโปรด", "คนขี้แกล้ง"] },
  });
  check("การ์ดครบรูปตามที่กำหนด", card === "Farris (คนรัก) ❤️ 199 [+12] #คนโปรด #คนขี้แกล้ง\nอารมณ์: สงบ", card);

  const imageAndMood = dataOf({
    text: "เขิน",
    image: { buffer: Buffer.from("x"), name: "shy.png" },
    mood: "อาย",
    color: 0xe91e63,
    status: { userName: "Yuuta", bond: "friend", xp: 160, xpDelta: 10 },
  });
  check("มีรูป + mood + color + status ไปด้วยกัน", imageAndMood.color === 0xe91e63
    && (imageAndMood.footer as { text?: string }).text === "Yuuta (เพื่อน) 🙂 160 [+10]\nอารมณ์: อาย"
    && (imageAndMood.image as { url?: string }).url === "attachment://shy.png");

  // of-Discord proof: ทุกค่ารอดผ่าน MessagePayload ไปถึง body จริง
  const target = {
    isMessage: false,
    client: { options: { failIfNotExists: true, jsonTransformer: (x: unknown) => x } },
    messages: { resolveId: (x: unknown) => (typeof x === "string" ? x : null) },
  };
  const payload = new MessagePayload(target as never, buildReplyPayload({
    text: "ขอบคุณค่ะ", mood: "ขอบคุณ", color: 0xf1c40f, replyTo: "999",
    status: { userName: "Farris", bond: "lover", xp: 199, xpDelta: 12, nickname: ["คนโปรด"] },
  }) as never);
  payload.resolveBody();
  const body = payload.body as {
    embeds?: Array<{ color?: number; footer?: { text?: string }; description?: string; timestamp?: string }>;
    message_reference?: { message_id?: string };
  };
  check("body ที่ส่งให้ Discord มี color", body.embeds?.[0]?.color === 0xf1c40f);
  check("body มี footer สองบรรทัดตามรูปแบบ", body.embeds?.[0]?.footer?.text === "Farris (คนรัก) ❤️ 199 [+12] #คนโปรด\nอารมณ์: ขอบคุณ");
  check("footer/color ไม่ไปทับ message_reference", body.message_reference?.message_id === "999");
  check("ข้อความยังอยู่ใน description (ไม่ไปปนกับ mood)", body.embeds?.[0]?.description === "ขอบคุณค่ะ");
  check("embed มี timestamp เป็น ISO string", typeof body.embeds?.[0]?.timestamp === "string"
    && !Number.isNaN(Date.parse(body.embeds?.[0]?.timestamp ?? "")), body.embeds?.[0]?.timestamp);
}

console.log("=== 9. setTimestamp: ไม่ hardcode, ไม่พังเมื่อค่าใช้ไม่ได้ ===");
{
  const dataOf = (options: Parameters<typeof buildReplyPayload>[0]) =>
    (buildReplyPayload(options).embeds?.[0] as { data?: Record<string, unknown> }).data ?? {};

  const fixed = new Date("2026-08-31T13:00:00.000Z");
  const stamped = dataOf({ text: "ค่ะ", timestamp: fixed });
  check("timestamp ที่ส่งมาใช้ตรงตัว", stamped.timestamp === "2026-08-31T13:00:00.000Z", stamped.timestamp);

  const epoch = dataOf({ text: "ค่ะ", timestamp: 1787000000000 });
  check("รับ number (epoch ms) ได้", epoch.timestamp === new Date(1787000000000).toISOString(), epoch.timestamp);

  const iso = dataOf({ text: "ค่ะ", timestamp: "2026-08-31T13:00:00.000Z" });
  check("รับ ISO string ได้ (builders ไม่รับ string ตรง ๆ ต้องแปลงก่อน)", iso.timestamp === "2026-08-31T13:00:00.000Z", iso.timestamp);

  const before = Date.now();
  const defaulted = dataOf({ text: "ค่ะ" });
  const after = Date.now();
  const autoMs = Date.parse(String(defaulted.timestamp));
  check("ไม่ส่ง timestamp -> ใช้เวลาตอนนี้ (ไม่ใช่ค่าคงที่ในโค้ด)", autoMs >= before - 1000 && autoMs <= after + 1000, defaulted.timestamp);

  const junk = dataOf({ text: "ค่ะ", timestamp: "เมื่อวาน" });
  check("ค่าที่ parse ไม่ได้เลย -> ไม่ตั้ง timestamp เลย (ไม่ throw)", !("timestamp" in junk), junk.timestamp);

  const zero = dataOf({ text: "ค่ะ", timestamp: 0 });
  check("timestamp = 0 (epoch) ถูกมองข้าม ไม่กลายเป็น 1970", !("timestamp" in zero), zero.timestamp);
}

console.log("=== 10. embed-footer: การตัดชื่อ/ป้าย และค่าที่ขาด ===");
{
  check("ชื่อเกิน 12 ตัวอักษรถูกตัด + ellipsis", footer.footerNameOf("Farris Farrisovich Long") === "Farris Farr…", footer.footerNameOf("Farris Farrisovich Long"));
  check("ชื่อ 12 ตัวพอดีไม่ถูกตัด", footer.footerNameOf("abcdefghijkl") === "abcdefghijkl");
  check("ชื่อภาษาไทยไม่ถูกตัดกลางสระ/วรรณยุกต์", (() => {
    const name = "ไอล่า测试ชื่อไทยยาวมาก";
    const clipped = footer.footerNameOf(name);
    return clipped.length <= 12 && !/[\u0E31\u0E34-\u0E3A\u0E47-\u0E4E]$/.test(clipped);
  })(), footer.footerNameOf("ไอล่า测试ชื่อไทยยาวมาก"));
  check("ชื่อว่าง -> ไม่มีบรรทัดสถานะ", footer.statusLineOf({ userName: "  ", bond: "lover", xp: 5 }) === "");
  check("bond ไม่รู้จัก -> ไม่แต่งสถานะให้", footer.statusLineOf({ userName: "A", bond: "bestie", xp: 3 }) === "A 3");
  check("xpDelta 0 -> ไม่ใส่ [0]", footer.statusLineOf({ userName: "A", bond: "friend", xp: 3, xpDelta: 0 }) === "A (เพื่อน) 🙂 3");
  check("xpDelta ติดลบมีเครื่องหมาย", footer.xpDeltaText(-7) === "-7" && footer.xpDeltaText(7) === "+7" && footer.xpDeltaText(0) === "");
  check("xpDelta หายไป -> ไม่มี []", footer.statusLineOf({ userName: "A", bond: "friend", xp: 3 }) === "A (เพื่อน) 🙂 3");

  // --- the turn's receipts: [+15] [Flirt +1] [Lover Unlocked] ---
  check("flirt เทิร์นนี้ -> [Flirt +1] ต่อท้ายแต้ม",
    footer.statusLineOf({ userName: "Farris", bond: "lover", xp: 109, xpDelta: 15, flirtDelta: 1 }) === "Farris (คนรัก) ❤️ 109 [+15] [Flirt +1]",
    footer.statusLineOf({ userName: "Farris", bond: "lover", xp: 109, xpDelta: 15, flirtDelta: 1 }));
  check("ผ่านเงื่อนไข -> [Lover Unlocked]",
    footer.statusLineOf({ userName: "Farris", bond: "lover", xp: 109, xpDelta: 15, bondUnlocked: true }) === "Farris (คนรัก) ❤️ 109 [+15] [Lover Unlocked]",
    footer.statusLineOf({ userName: "Farris", bond: "lover", xp: 109, xpDelta: 15, bondUnlocked: true }));
  check("ทั้ง flirt และ unlock พร้อมกัน เรียง [+xp][Flirt][Unlocked]",
    footer.statusLineOf({ userName: "Farris", bond: "crush", xp: 520, xpDelta: 10, flirtDelta: 1, bondUnlocked: true }) === "Farris (แอบชอบ) 💗 520 [+10] [Flirt +1] [Crush Unlocked]",
    footer.statusLineOf({ userName: "Farris", bond: "crush", xp: 520, xpDelta: 10, flirtDelta: 1, bondUnlocked: true }));
  check("flirtDelta 0 -> ไม่ใส่ป้าย", footer.statusLineOf({ userName: "A", bond: "friend", xp: 3, xpDelta: 1, flirtDelta: 0 }) === "A (เพื่อน) 🙂 3 [+1]");
  check("flirtDelta ติดลบ/NaN ถูกทิ้ง ไม่กลายเป็น [Flirt +-1]",
    footer.statusBadges({ flirtDelta: -1 }).length === 0 && footer.statusBadges({ flirtDelta: NaN }).length === 0);
  check("bondUnlocked จริงแต่ bond ไม่รู้จัก -> ไม่แต่งป้าย",
    footer.statusLineOf({ userName: "A", bond: "bestie", xp: 3, bondUnlocked: true }) === "A 3");
  check("stranger/enemy ไม่เคยมีป้าย unlock แม้ถูกสั่ง",
    footer.statusBadges({ bond: "stranger", bondUnlocked: true }).length === 0 &&
    footer.statusBadges({ bond: "enemy", bondUnlocked: true }).length === 0);
  check("ป้ายอยู่ได้แม้ไม่มี xp (xp หายไป)",
    footer.statusLineOf({ userName: "A", bond: "friend", flirtDelta: 1 }) === "A (เพื่อน) 🙂 [Flirt +1]");
  check("nickname ยังอยู่ท้ายสุดหลังป้ายทั้งหมด",
    footer.statusLineOf({ userName: "A", bond: "friend", xp: 3, xpDelta: 1, flirtDelta: 1, nickname: ["คนโปรด"] }) === "A (เพื่อน) 🙂 3 [+1] [Flirt +1] #คนโปรด");
  check("nickname เกิน 3 ป้ายถูกตัด", footer.nicknameTagsOf(["a", "b", "c", "d", "e"]) === "#a #b #c");
  check("nickname ว่าง/มี # ซ้ำถูกทิ้ง", footer.nicknameTagsOf(["", "  ", "มี#ในคำ", "\n"]) === "#มีในคำ");
  check("nickname ยาวถูกตัด", (() => {
    const tag = footer.nicknameTagsOf(["ชื่อเล่นยาวมากเป็นพิเศษสำหรับทดสอบการตัด"]);
    return tag.startsWith("#") && tag.length <= footer.MAX_NICKNAME_CHARS + 1;
  })(), footer.nicknameTagsOf(["ชื่อเล่นยาวมากเป็นพิเศษสำหรับทดสอบการตัด"]));
  check("mood ว่าง -> ไม่มีบรรทัดอารมณ์", footer.moodLineOf("   ") === "");
  check("mood หลายช่องว่างถูกบีบ", footer.moodLineOf("  ยินดี   มาก  ") === "อารมณ์: ยินดี มาก");
  check("ทุก bond มี emoji", bondsAll.every((b) => bondEmoji(b) !== ""));
  check("bond ไม่รู้จัก -> emoji ว่าง", bondEmoji("nope") === "" && bondEmoji(null) === "");
}

console.log("=== 11. mention แบบอื่นที่ AI เห็น: role / channel / @everyone / slash / emoji ===");
{
  // Built on a REAL discord.js Client with REAL caches, offline (no login, no network).
  // This exists because `cleanContent` is not one function we own: role/channel mentions resolve
  // through guild.roles.cache and client.channels.cache, so the answer to "what does the model see"
  // depends on whether those caches are populated. A hand-built object cannot answer that.
  const GUILD = "1500000000000000001";
  const CH = "1500000000000000002";
  const ROLE = "1500000000000000003";
  const UNKNOWN_ROLE = "1500000000000000004";
  const OTHER_CH = "1500000000000000005";
  const USER = "1500000000000000006";
  const UNKNOWN_USER = "1500000000000000099";

  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  });
  // discord.js marks `_add` as internal (private in the typings) and types `channels._add` as the
  // base `Channel`, so the cache-seeding calls go through this helper. At runtime it is exactly what
  // the gateway does with a GUILD_CREATE / MESSAGE_CREATE payload.
  const add = <T>(manager: unknown, data: unknown): T =>
    (manager as { _add(d: unknown): unknown })._add(data) as T;

  // Same shape GUILD_CREATE delivers: roles[] and channels[] ride along, and Guild.js feeds them
  // into guild.roles._add() / client.channels._add() (Guild.js:399,411). That is why the Guilds
  // intent alone is enough for role/channel names to resolve.
  add(client.guilds, {
    id: GUILD,
    name: "testguild",
    unavailable: false,
    roles: [
      { id: GUILD, name: "@everyone", permissions: "0", color: 0, hoist: false, managed: false, position: 0 },
      { id: ROLE, name: "Moderator", permissions: "0", color: 0, hoist: true, managed: false, position: 1 },
    ],
    channels: [{ id: CH, name: "general", type: ChannelType.GuildText, position: 0 }],
    members: [
      { user: { id: USER, username: "yuuta", discriminator: "0", global_name: "Yuuta G." }, nick: "Yuuta-nick", roles: [ROLE] },
    ],
  });
  const channel = add<{ messages: unknown }>(client.channels, { id: CH, guild_id: GUILD, name: "general", type: ChannelType.GuildText });
  add(client.channels, { id: OTHER_CH, guild_id: GUILD, name: "off-topic", type: ChannelType.GuildText });

  const raw =
    `สวัสดี <@&${ROLE}> <@&${UNKNOWN_ROLE}> <#${CH}> <#${OTHER_CH}> ` +
    `<@${USER}> <@${UNKNOWN_USER}> @everyone @here </isla:1543313183719030816> <:DeepSeek:1234567890123456789>`;
  const message = add<Message>(channel.messages, {
    id: "1544000000000000001",
    channel_id: CH,
    guild_id: GUILD,
    content: raw,
    author: { id: USER, username: "yuuta", discriminator: "0", global_name: "Yuuta G." },
    timestamp: "2026-09-01T00:00:00.000Z",
    edited_timestamp: null,
    mention_everyone: true,
    mention_roles: [ROLE, UNKNOWN_ROLE],
    mentions: [{ id: USER, username: "yuuta", discriminator: "0", global_name: "Yuuta G.", member: { nick: "Yuuta-nick", roles: [ROLE] } }],
  });

  const seen = textForModel(message);
  check("role ที่รู้จัก -> @RoleName (ไม่ใช่ <@&id>)", seen.includes("@Moderator"), seen);
  check("ไม่มี <@&...> หลงเหลือสำหรับ role ที่ cache มี", !seen.includes(`<@&${ROLE}>`));
  check("role ไม่รู้จัก -> คง <@&id> ดิบไว้ (cleanContent ไม่แต่งชื่อ)", seen.includes(`<@&${UNKNOWN_ROLE}>`));
  check("channel ใน guild -> #name", seen.includes("#general") && seen.includes("#off-topic"), seen);
  check("ไม่มี <#id> ของ channel ที่ cache มี", !seen.includes(`<#${CH}>`) && !seen.includes(`<#${OTHER_CH}>`));
  check("user mention -> @guild nickname (precedence เดียวกับ displayNameOf)", seen.includes("@Yuuta-nick"));
  check("user ไม่รู้จัก -> คง <@id> ดิบ", seen.includes(`<@${UNKNOWN_USER}>`));
  check("@everyone/@here ผ่านไปเหมือนเดิม (ไม่ใช่รูปแบบ <...>)", seen.includes("@everyone") && seen.includes("@here"));
  check("slash command -> /isla (id หายไป)", seen.includes("/isla") && !seen.includes("1543313183719030816"), seen);
  check("custom emoji -> :DeepSeek: ในข้อความที่ AI เห็น", seen.includes(":DeepSeek:"));
  check("แต่ content ดิบยังมี id ให้ media.ts ใช้", message.content.includes("<:DeepSeek:1234567890123456789>"));
  check("textForModel != content (พิสูจน์ว่าใช้ cleanContent จริง)", seen !== message.content);

  // The scheduled turn — what actually reaches the pipeline and history — must carry the words.
  const scheduled = toScheduledMessage(message);
  check("toScheduledMessage ใช้ค่าเดียวกับ textForModel", scheduled?.text === seen);
  // Only ids the caches DO know are replaced; an unknown id stays raw on purpose (asserted above),
  // so the regex is scoped to the known ones rather than "no snowflakes at all".
  check("snowflake ที่ cache รู้จัก หายจาก text ที่เข้า AI",
    !new RegExp(`<@&${ROLE}>|<@${USER}>|<#${CH}>|<#${OTHER_CH}>`).test(scheduled?.text ?? ""),
    scheduled?.text);
  check("media ยังมาจาก content ดิบ: อิโมจิได้ id ไปทำ CDN URL",
    scheduled?.media?.[0]?.url === "https://cdn.discordapp.com/emojis/1234567890123456789.png",
    JSON.stringify(scheduled?.media));
  check("role/channel mention ไม่ใช่ media (ไม่ไปดาวน์โหลดอะไรเพิ่ม)",
    (scheduled?.media?.length ?? 0) === 1);

  // Proof that the caches — not a hardcoded table — are the source of the names.
  client.guilds.cache.get(GUILD)!.roles.cache.delete(ROLE);
  client.channels.cache.delete(OTHER_CH);
  const degraded = textForModel(message);
  check("ลบ role ออกจาก cache -> กลายเป็น <@&id> ดิบ (ชื่อมาจาก cache ล้วน ๆ)",
    !degraded.includes("@Moderator") && degraded.includes(`<@&${ROLE}>`), degraded);
  check("ลบ channel ออกจาก cache -> กลายเป็น <#id> ดิบ",
    !degraded.includes("#off-topic") && degraded.includes(`<#${OTHER_CH}>`));
}

rmSync(dir, { recursive: true, force: true });
console.log(`\n${fail === 0 ? "✅" : "❌"} ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
