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
import { MessagePayload } from "discord.js";
import {
  buildReplyPayload,
  replyAnchorOf,
  replyReference,
  toScheduledMessage,
} from "../src/bot/message-handler.js";
import { MessageScheduler, type ScheduledMessage } from "../src/pipeline/scheduler.js";

let pass = 0;
let fail = 0;
function check(label: string, cond: boolean): void {
  console.log(`  ${cond ? "✅" : "❌"} ${label}`);
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

console.log(`\n${fail === 0 ? "✅" : "❌"} ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
