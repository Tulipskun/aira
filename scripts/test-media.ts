// Tests for src/bot/media.ts — everything the bot now does with attachments, custom emojis and
// stickers: where the URLs come from, how bytes are classified, how a GIF becomes a video, and
// how the result is serialised into Interactions content parts.   bun run scripts/test-media.ts
//
// No network and no API quota. The only external process used is ffmpeg, and only for the GIF
// cases; those are skipped (not failed) when the binary is missing.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import sharp from "sharp";
import type { Interactions } from "@google/genai";
import type { Message } from "../src/gemini/client.js";

const run = promisify(execFile);

let pass = 0;
let fail = 0;
let skipped = 0;
function check(label: string, cond: boolean, detail = ""): void {
  console.log(`  ${cond ? "✅" : "❌"} ${label}${cond ? "" : detail ? ` — ${detail}` : ""}`);
  if (cond) pass++; else fail++;
}
function skip(label: string, why: string): void {
  console.log(`  ⏭️  ${label} — skipped (${why})`);
  skipped++;
}

const dir = mkdtempSync(join(tmpdir(), "aira-media-test-"));
// Importing message-handler pulls in the pipeline and the SQLite layer; point it at a throwaway
// database so a test run can never touch the bot's real history.
process.env.SQLITE_PATH = join(dir, "test.db");

const {
  effectiveMime,
  parseCustomEmojis,
  mediaSourcesOf,
  classifyMedia,
  collectMedia,
  mediaToContent,
  mediaSummary,
  prepareMedia,
  gifToVideo,
  resolveFfmpegPath,
  isDiscordMediaUrl,
} = await import("../src/bot/media.js");
const { messageStep, ctxWindowCreate } = await import("../src/gemini/client.js");
const { toScheduledMessage, MEDIA_ONLY_TEXT } = await import("../src/bot/message-handler.js");

// ---------------------------------------------------------------- fixtures

const PNG = await sharp({ create: { width: 24, height: 24, channels: 3, background: "#00ff00" } }).png().toBuffer();
const ONE_FRAME_GIF = await sharp(PNG, { animated: true }).gif({ loop: 0 }).toBuffer();

const ffmpeg = await resolveFfmpegPath();
console.log(`ffmpeg: ${ffmpeg ?? "NOT FOUND — GIF→video cases will be skipped"}`);

/** A real multi-frame GIF built by ffmpeg's testsrc (moving pattern + frame counter). */
async function makeGif(seconds: number): Promise<Buffer | null> {
  if (!ffmpeg) return null;
  const out = join(dir, `in-${seconds}s.gif`);
  try {
    await run(ffmpeg, [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", `testsrc=size=64x64:rate=10:duration=${seconds}`,
      "-vf", "fps=10", out,
    ]);
    return readFileSync(out);
  } catch {
    return null;
  }
}

/** A real MP4 (h264) so classification can be tested against actual video bytes. */
async function makeMp4(seconds: number): Promise<Buffer | null> {
  if (!ffmpeg) return null;
  const out = join(dir, `in-${seconds}s.mp4`);
  try {
    await run(ffmpeg, [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", `testsrc=size=64x64:rate=10:duration=${seconds}`,
      "-pix_fmt", "yuv420p", "-f", "mp4", out,
    ]);
    return readFileSync(out);
  } catch {
    return null;
  }
}

/** ffmpeg -i … -f null - prints the container summary to stderr; ffprobe is not bundled. */
async function probeMp4(data: Buffer, tag: string): Promise<{ seconds: number | null; frames: number | null }> {
  const file = join(dir, `${tag}.mp4`);
  writeFileSync(file, data);
  let stderr = "";
  try {
    stderr = (await run(ffmpeg as string, ["-hide_banner", "-i", file, "-f", "null", "-"])).stderr;
  } catch (error) {
    stderr = String((error as { stderr?: string }).stderr ?? error);
  }
  const duration = /Duration:\s*(\d+):(\d+):([\d.]+)/.exec(stderr);
  const frames = [...stderr.matchAll(/frame=\s*(\d+)/g)].pop();
  return {
    seconds: duration ? Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3]) : null,
    frames: frames ? Number(frames[1]) : null,
  };
}

// ============================================================ 1. MIME resolution

console.log("=== 1. effectiveMime: Discord's contentType, with an extension fallback ===");
check("real content type wins", effectiveMime("image/webp", "sticker.webp") === "image/webp");
check("case is normalised", effectiveMime("IMAGE/PNG", "a.png") === "image/png");
check("octet-stream falls back to the extension", effectiveMime("application/octet-stream", "clip.mp4") === "video/mp4");
check("null content type falls back too", effectiveMime(null, "photo.JPG") === "image/jpeg");
check("gif is detected by extension", effectiveMime("application/octet-stream", "x.gif") === "image/gif");
check("unknown extension with no type stays empty", effectiveMime("", "mystery.xyz") === "");

// ============================================================ 2. custom emojis

console.log("=== 2. parseCustomEmojis ===");
const emojis = parseCustomEmojis("hi <:wave:123> <:wave:123> <a:dance:456> 🙂 @everyone");
check("two distinct emojis, duplicates collapsed", emojis.length === 2, JSON.stringify(emojis));
check("static one is a png", emojis[0]?.mimeType === "image/png" && emojis[0]?.url === "https://cdn.discordapp.com/emojis/123.png", JSON.stringify(emojis[0]));
check("animated one is a gif", emojis[1]?.mimeType === "image/gif" && emojis[1]?.url === "https://cdn.discordapp.com/emojis/456.gif", JSON.stringify(emojis[1]));
check("names keep the colon form", emojis[0]?.name === ":wave:" && emojis[1]?.name === ":dance:");
check("unicode emoji and @everyone are not media", parseCustomEmojis("🙂 🎉 @everyone <@123>").length === 0);
check("malformed mention is ignored", parseCustomEmojis("<:noname:> <:ok:abc>").length === 0);

// ============================================================ 3. sources from a message

console.log("=== 3. mediaSourcesOf: attachments, then emojis, then stickers ===");
const sources = mediaSourcesOf({
  content: "look <:wave:123>",
  attachments: {
    values: () => [
      { name: "photo.jpg", contentType: "image/jpeg", url: "https://cdn.discordapp.com/attachments/1/2/photo.jpg", proxyURL: "https://media.discordapp.net/attachments/1/2/photo.jpg" },
      { name: null, contentType: null, url: "https://cdn.discordapp.com/attachments/1/3/blob" },
    ],
  },
  stickers: { values: () => [{ name: "duck", format: 1, url: "https://cdn.discordapp.com/stickers/777.png" }] },
});
check("four sources: 2 attachments + emoji + sticker", sources.length === 4, JSON.stringify(sources));
check("attachment order preserved", sources[0]?.name === "photo.jpg" && sources[1]?.name === "attachment");
check("proxyURL preferred over CDN", sources[0]?.url.startsWith("https://media.discordapp.net/"), sources[0]?.url);
check("missing name defaults to 'attachment'", sources[1]?.name === "attachment");
check("emoji comes after attachments", sources[2]?.name === ":wave:", JSON.stringify(sources[2]));
check("sticker comes last", sources[3]?.name === "duck", JSON.stringify(sources[3]));

const stickerOf = (format: number, url: string) =>
  mediaSourcesOf({ stickers: { values: () => [{ name: "s", format, url }] } })[0];
console.log("--- stickers by format (discord.js StickerFormatType) ---");
check("PNG sticker → image/png", stickerOf(1, "u.png")?.mimeType === "image/png");
check("APNG sticker → image/png", stickerOf(2, "u.png")?.mimeType === "image/png");
check("Lottie sticker is not faked as an image", stickerOf(3, "u.json")?.mimeType === "application/json", JSON.stringify(stickerOf(3, "u.json")));
check("GIF sticker → image/gif", stickerOf(4, "u.gif")?.mimeType === "image/gif");
check("unknown format falls back to png", stickerOf(99, "u.png")?.mimeType === "image/png");

check("plain text yields no sources", mediaSourcesOf({ content: "hello" }).length === 0);
check("missing collections are tolerated", mediaSourcesOf({}).length === 0);

console.log("--- link unfurls (message.embeds) ---");
const embedSources = mediaSourcesOf({
  content: "https://klipy.com/gifs/love-114",
  embeds: {
    values: () => [
      // A gifv-style provider: Discord exposes a proxied mp4 `video`, no `image`.
      { url: "https://klipy.com/gifs/love-114", video: { url: "https://cdn.discordapp.com/embed/attachments/1/2.gif", proxyURL: "https://media.discordapp.net/embed/attachments/1/2.gif" } },
      // An image-only unfurl.
      { url: "https://example.com/cat.png", image: { url: "https://cdn.discordapp.com/proxy/3/cat.png", proxyURL: null } },
      // Thumbnail only (no image/video) — still worth one source.
      { thumbnail: { url: "https://cdn.discordapp.com/proxy/4/thumb.jpg" } },
      // Nothing media-shaped, and a non-Direct proxy that must never be fetched.
      { url: "https://example.com/article" },
      { image: { url: "https://evil.test/x.png", proxyURL: "https://evil.test/x.png" } },
    ],
  },
});
check("one source per usable embed, not image+thumbnail", embedSources.length === 3, JSON.stringify(embedSources));
check("video preferred and named by origin host", embedSources[0]?.name === "klipy.com/2.gif" && embedSources[0]?.mimeType === "video/mp4", JSON.stringify(embedSources[0]));
check("proxyURL preferred for embeds too", embedSources[0]?.url.startsWith("https://media.discordapp.net/"), embedSources[0]?.url);
check("image-only embed is an image", embedSources[1]?.name === "example.com/cat.png" && embedSources[1]?.mimeType === "image/png", JSON.stringify(embedSources[1]));
check("thumbnail-only embed still counts", embedSources[2]?.mimeType === "image/jpeg", JSON.stringify(embedSources[2]));
check("non-Discord embed URL is refused at the source", embedSources.every((s) => isDiscordMediaUrl(s.url)), JSON.stringify(embedSources));

const dup = mediaSourcesOf({
  content: "x",
  attachments: { values: () => [{ name: "a.png", contentType: "image/png", url: "https://cdn.discordapp.com/attachments/1/2/a.png", proxyURL: "https://media.discordapp.net/attachments/1/2/a.png" }] },
  embeds: { values: () => [{ image: { url: "https://cdn.discordapp.com/attachments/1/2/a.png", proxyURL: "https://media.discordapp.net/attachments/1/2/a.png" } }] },
});
check("attachment and its own embed are not billed twice", dup.length === 1, JSON.stringify(dup));

// ============================================================ 4. classification

console.log("=== 4. classifyMedia: what the model can actually read ===");
const kindOf = (name: string, mimeType: string, data: Buffer = PNG) => classifyMedia({ name, mimeType, data });
check("png → image", (await kindOf("a.png", "image/png")).kind === "image");
check("jpeg → image", (await kindOf("a.jpg", "image/jpeg")).kind === "image");
check("mp4 → video", (await kindOf("a.mp4", "video/mp4")).kind === "video");
check("webm → video", (await kindOf("a.webm", "video/webm")).kind === "video");
check("mp3 → audio", (await kindOf("a.mp3", "audio/mpeg")).kind === "audio");
check("pdf → document", (await kindOf("a.pdf", "application/pdf")).kind === "document");
check("csv → document", (await kindOf("a.csv", "text/csv")).kind === "document");
const zip = await kindOf("a.zip", "application/zip");
check("zip → unsupported", zip.kind === "unsupported", JSON.stringify(zip));
check("unsupported carries a reason", zip.kind === "unsupported" && /not readable/.test(zip.reason), JSON.stringify(zip));
check("label falls back to the mime when nameless", (await kindOf("", "application/zip")).label === "application/zip");
check("lottie bytes are refused, not sent as a picture", (await kindOf("s.json", "application/json", Buffer.from("{}"))).kind === "unsupported");

console.log("--- GIF: transcoded to video, or degraded honestly ---");
const gif2 = await makeGif(2);
const gif6 = await makeGif(6);
if (ffmpeg && gif2 && gif6) {
  const plain = await classifyMedia({ name: "anim.gif", mimeType: "image/gif", data: gif2 });
  check("GIF becomes a video item", plain.kind === "video", JSON.stringify({ kind: plain.kind }));
  if (plain.kind === "video") {
    check("transcoded mime is video/mp4", plain.mimeType === "video/mp4", plain.mimeType);
    check("2s GIF at the default 2fps → 4 frames", plain.fps === 2, String(plain.fps));
    check("label states the sampling", /animated GIF, 2\.0s sampled at 2\.00 fps/.test(plain.label), plain.label);
    check("bytes are no longer a raw GIF", !plain.data.subarray(0, 3).toString("latin1").startsWith("GIF8"));
    check("mp4 box header present", plain.data.subarray(4, 8).toString("latin1") === "ftyp", plain.data.subarray(0, 12).toString("hex"));
    check("stream is fragmented (moof box)", plain.data.includes("moof"), "no moof box");
    const probe = await probeMp4(plain.data, "plain");
    check("ffmpeg reads it back as 2s / 4 frames", probe.seconds === 2 && probe.frames === 4, JSON.stringify(probe));
  }

  // The frame budget: fps cannot go below 1, so a long GIF is truncated instead.
  const capped = await classifyMedia({ name: "long.gif", mimeType: "image/gif", data: gif6 }, { gifFps: 2, gifMaxFrames: 4 });
  check("capped GIF is still a video", capped.kind === "video", JSON.stringify({ kind: capped.kind }));
  if (capped.kind === "video") {
    check("6s GIF capped to 4 frames drops to 1fps", capped.fps === 1, String(capped.fps));
    check("label admits the truncation", /first 4 frames only/.test(capped.label), capped.label);
    const cappedProbe = await probeMp4(capped.data, "capped");
    check("capped clip really is 4 frames / 4s", cappedProbe.frames === 4 && cappedProbe.seconds === 4, JSON.stringify(cappedProbe));
  }

  const roomy = await classifyMedia({ name: "long.gif", mimeType: "image/gif", data: gif6 }, { gifFps: 2, gifMaxFrames: 24 });
  check("roomy GIF is still a video", roomy.kind === "video", JSON.stringify({ kind: roomy.kind }));
  if (roomy.kind === "video") {
    check("an unbinding budget keeps the requested fps", roomy.fps === 2, String(roomy.fps));
    check("no truncation note when the whole clip fits", !/only/.test(roomy.label), roomy.label);
    const roomyProbe = await probeMp4(roomy.data, "roomy");
    check("6s GIF at 2fps → 12 frames", roomyProbe.frames === 12 && roomyProbe.seconds === 6, JSON.stringify(roomyProbe));
  }

  // Discord's gifv proxies serve MP4 bytes from a URL ending in `.gif`. The name must not drag
  // real video through the GIF transcoder.
  const mp4 = await makeMp4(2);
  if (mp4) {
    const mislabelled = await classifyMedia({ name: "clip.gif", mimeType: "image/gif", data: mp4 });
    check("MP4 bytes with a .gif name are video, not re-transcoded", mislabelled.kind === "video" && mislabelled.mimeType === "video/mp4", JSON.stringify({ kind: mislabelled.kind, mime: (mislabelled as { mimeType?: string }).mimeType }));
    check("sniffMime reads the container", (mislabelled.kind === "video" ? "video/mp4" : "") === "video/mp4");
  } else {
    skip("MP4 bytes with a .gif name", "no ffmpeg to build the fixture");
  }

  check("gifToVideo returns bytes", (await gifToVideo(gif2, 2)) !== null);
  check("gifToVideo refuses garbage", (await gifToVideo(Buffer.from("not a gif at all"), 2)) === null);
} else if (gif2) {
  const degraded = await classifyMedia({ name: "anim.gif", mimeType: "image/gif", data: gif2 });
  check("without ffmpeg a GIF degrades to a still image", degraded.kind === "image" && degraded.mimeType === "image/gif", JSON.stringify({ kind: degraded.kind }));
  check("the label admits only one frame is visible", /first frame/.test(degraded.label), degraded.label);
  skip("GIF→video transcode cases", "ffmpeg not installed");
} else {
  const degraded = await classifyMedia({ name: "anim.gif", mimeType: "image/gif", data: ONE_FRAME_GIF });
  check("without ffmpeg a GIF degrades to a still image", degraded.kind === "image" && degraded.mimeType === "image/gif");
  check("the label admits only one frame is visible", /first frame/.test(degraded.label), degraded.label);
  skip("GIF→video transcode cases", "ffmpeg not installed");
}

// ============================================================ 5. serialisation

console.log("=== 5. mediaToContent: Interactions parts ===");
const parts = mediaToContent([
  { kind: "image", data: PNG, mimeType: "image/png", label: "a.png" },
  { kind: "video", data: PNG, mimeType: "video/mp4", label: "b.mp4", fps: 2 },
  { kind: "audio", data: PNG, mimeType: "audio/mpeg", label: "c.mp3" },
  { kind: "document", data: PNG, mimeType: "application/pdf", label: "d.pdf" },
  { kind: "unsupported", label: "e.zip", reason: "application/zip is not readable by the model" },
]);
check("one part per item", parts.length === 5, JSON.stringify(parts.map((p) => p.type)));
check("types map 1:1", parts.map((p) => p.type).join(",") === "image,video,audio,document,text", parts.map((p) => p.type).join(","));
check("bytes are base64", (parts[0] as { data?: string }).data === PNG.toString("base64"));
check("mime_type is carried", (parts[0] as { mime_type?: string }).mime_type === "image/png");
check("video gets processing.fps", JSON.stringify((parts[1] as { processing?: unknown }).processing) === '{"type":"static","fps":2}', JSON.stringify((parts[1] as { processing?: unknown }).processing));
check("image gets no processing", (parts[0] as { processing?: unknown }).processing === undefined);
check("video without fps gets no processing", (mediaToContent([{ kind: "video", data: PNG, mimeType: "video/mp4", label: "x" }])[0] as { processing?: unknown }).processing === undefined);
check("unsupported becomes a readable text note", (parts[4] as { text?: string }).text === "[e.zip — application/zip is not readable by the model]", JSON.stringify((parts[4] as { text?: string }).text));
check("empty list yields no parts", mediaToContent([]).length === 0);

console.log("=== 6. summary + prepareMedia ===");
check("summary lists kinds", mediaSummary([{ kind: "image", data: PNG, mimeType: "image/png", label: "a.png" }, { kind: "video", data: PNG, mimeType: "video/mp4", label: "b.mp4" }]) === "a.png [image], b.mp4 [video]", mediaSummary([{ kind: "image", data: PNG, mimeType: "image/png", label: "a.png" }, { kind: "video", data: PNG, mimeType: "video/mp4", label: "b.mp4" }]));
check("summary explains failures", mediaSummary([{ kind: "unsupported", label: "e.zip", reason: "could not be downloaded" }]) === "e.zip (could not be downloaded)");
check("no media → empty summary", mediaSummary([]) === "");

const nothing = await prepareMedia([]);
check("prepareMedia([]) is inert", nothing.parts.length === 0 && nothing.summary === "" && nothing.hasVisual === false);

// A closed port fails fast without touching the public internet. allowUrl is widened here only
// because the point of this case is the *download* failure path; production stays Discord-only.
const LOCAL = { allowUrl: () => true };
const dead = await prepareMedia([{ name: "gone.png", mimeType: "image/png", url: "http://127.0.0.1:9/gone.png" }], LOCAL);
check("undownloadable media is reported, not thrown", dead.parts.length === 1 && dead.parts[0]?.type === "text", JSON.stringify(dead.parts));
check("hasVisual is false when nothing arrived", dead.hasVisual === false);
check("summary names the file", dead.summary.includes("gone.png"), dead.summary);

console.log("=== 7. collectMedia caps the batch ===");
const many = Array.from({ length: 6 }, (_, i) => ({ name: `p${i}.png`, mimeType: "image/png", url: "http://127.0.0.1:9/x.png" }));
check("default cap is 4 items", (await collectMedia(many, LOCAL)).length === 4);
check("cap is configurable", (await collectMedia(many, { ...LOCAL, maxItems: 2 })).length === 2);

console.log("=== 7b. only Discord-hosted bytes are fetched ===");
check("CDN and proxies allowed", ["https://cdn.discordapp.com/attachments/1/2/a.png", "https://media.discordapp.net/attachments/1/2/a.png", "https://cdn.discordapp.com/emojis/3.gif"]
  .every((u) => isDiscordMediaUrl(u)));
check("lookalike hosts rejected", ["https://cdn.discordapp.com.evil.test/a.png", "https://evil.test/?u=https://cdn.discordapp.com/a", "https://cdn.discordapp.co/a.png", "https://169.254.169.254/latest/meta-data/"]
  .every((u) => !isDiscordMediaUrl(u)));
check("non-https and junk rejected", !isDiscordMediaUrl("file:///etc/passwd") && !isDiscordMediaUrl("not a url"));
const blocked = await collectMedia([{ name: "x.png", mimeType: "image/png", url: "http://127.0.0.1:9/x.png" }]);
check("foreign host is refused before any request", blocked.length === 1 && blocked[0]?.kind === "unsupported" && /host not allowed/.test((blocked[0] as { reason?: string }).reason ?? ""), JSON.stringify(blocked));

// ============================================================ 8. wiring into the request

console.log("=== 8. the parts reach the model's turn ===");
const mediaParts = mediaToContent([{ kind: "image", data: PNG, mimeType: "image/png", label: "a.png" }]) as Interactions.Content[];
const turn: Message = { role: "user", user: "Tulip", text: "ดูนี่สิ", timestamp: "2026-08-31T10:00:00.000Z", fileName: "a.png [image]", media: mediaParts };
const step = messageStep(turn);
const content = (step as { content?: Interactions.Content[] }).content ?? [];
check("text part first, media after", content.length === 2 && content[0]?.type === "text" && content[1]?.type === "image", JSON.stringify(content.map((c) => c.type)));
check("metadata still describes the file", /a\.png/.test((content[0] as { text?: string }).text ?? ""), (content[0] as { text?: string }).text ?? "");
check("timestamp is rendered as Thailand time", /\+07:00/.test((content[0] as { text?: string }).text ?? ""), (content[0] as { text?: string }).text ?? "");
const plainStep = messageStep({ role: "user", user: "Tulip", text: "hi", timestamp: "2026-08-31T10:00:00.000Z" });
check("a turn without media has exactly one part", ((plainStep as { content: unknown[] }).content).length === 1);

const request = ctxWindowCreate(
  [{ role: "model", user: "Isla", text: "สวัสดี", timestamp: "2026-08-31T09:00:00.000Z" }],
  "ดูนี่สิ", "Tulip", "2026-08-31T10:00:00.000Z", "a.png [image]", [], "u1", mediaParts,
);
const last = request.messages[request.messages.length - 1];
check("current turn carries the media", (last.media?.length ?? 0) === 1 && last.media?.[0]?.type === "image");
check("history turn carries none", request.messages[0].media === undefined);
const historySteps = request.messages.map((m) => messageStep(m));
const built = (historySteps[1] as { content: Interactions.Content[] }).content;
check("built step has the text part plus the image", built.length === 2 && built[1].type === "image", JSON.stringify(built.map((c) => c.type)));

// ============================================================ 9. receive path

console.log("=== 9. toScheduledMessage no longer drops media-only messages ===");
const fake = (content: string, attachments: unknown[] = [], stickers: unknown[] = []) =>
  ({
    content,
    author: { id: "u1", username: "tulip", displayName: "Tulip" },
    member: null,
    attachments: { values: () => attachments, first: () => attachments[0] ?? null },
    stickers: { values: () => stickers },
    createdTimestamp: 1_789_000_000_000,
    channelId: "c1",
  }) as never;

check("text only", toScheduledMessage(fake("hello"))?.text === "hello");
check("text only has no media", toScheduledMessage(fake("hello"))?.media === undefined);
check("no text and no media → dropped", toScheduledMessage(fake("   ")) === null);
const mediaOnly = toScheduledMessage(fake("", [{ name: "a.png", contentType: "image/png", url: "https://cdn/a.png", proxyURL: null }]));
check("attachment with no text is kept", mediaOnly !== null);
check("its text stays empty (pipeline decides the placeholder)", mediaOnly?.text === "");
check("its media source survived", mediaOnly?.media?.[0]?.name === "a.png", JSON.stringify(mediaOnly?.media));
check("fileName still comes from the attachment", mediaOnly?.fileName === "a.png", mediaOnly?.fileName ?? "");
const stickerOnly = toScheduledMessage(fake("", [], [{ name: "duck", format: 1, url: "https://cdn/s.png" }]));
check("sticker-only message is kept", stickerOnly?.media?.[0]?.name === "duck", JSON.stringify(stickerOnly?.media));
const emojiOnly = toScheduledMessage(fake("<a:dance:456>"));
check("animated-emoji-only message is kept", (emojiOnly?.media?.length ?? 0) === 1 && emojiOnly?.media?.[0]?.mimeType === "image/gif", JSON.stringify(emojiOnly?.media));
check("placeholder is Thai and non-empty", MEDIA_ONLY_TEXT.trim().length > 0 && !/[a-z]/.test(MEDIA_ONLY_TEXT));

console.log("=== 10. the receive path must not drop empty-content messages before this point ===");
// bot.ts used to `return` on empty content, which made all of the above unreachable from Discord:
// a photo-only message never reached toScheduledMessage. Unit tests cannot exercise bot.ts (it
// logs in on import), so the wiring is asserted against its source instead.
const botSource = readFileSync(new URL("../src/bot/bot.ts", import.meta.url), "utf8");
check("no early return on empty content", !/if\s*\(\s*!?text\s*\)\s*return/.test(botSource), "bot.ts still drops messages with no text");
check("toScheduledMessage decides what is ignorable", /toScheduledMessage\(message\)/.test(botSource));
check("its null result is what gets dropped", /if\s*\(\s*!scheduled\s*\)\s*return/.test(botSource));

rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed${skipped ? `, ${skipped} skipped` : ""}`);
process.exit(fail ? 1 : 0);
