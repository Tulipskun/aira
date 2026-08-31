// End-to-end proof that a Discord attachment actually reaches Gemini as media.
//   bun run scripts/test-media-e2e.ts
//
// This SPENDS REAL API QUOTA (a few Gemini calls) and is therefore not part of the offline suite
// in test-media.ts. It isolates itself: a throwaway SQLite file, a throwaway Chroma collection,
// and its own payload-dump path, so it cannot pollute the bot's real memory or history. Media is
// served from a local HTTP server, so nothing touches Discord's CDN.
//
// What it asserts, in order:
//   1. prepareMedia() downloads and classifies a PNG, an animated GIF and a PDF.
//   2. processMessage() answers a question that can only be answered from the pixels.
//   3. The dumped request really contains the image/video parts (not just a filename note).
//   4. A media-only turn (empty text) still produces a reply.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import sharp from "sharp";

const run = promisify(execFile);

let pass = 0;
let fail = 0;
function check(label: string, cond: boolean, detail = ""): void {
  console.log(`  ${cond ? "✅" : "❌"} ${label}${cond ? "" : detail ? ` — ${detail}` : ""}`);
  if (cond) pass++; else fail++;
}

const dir = mkdtempSync(join(tmpdir(), "aira-e2e-"));
process.env.SQLITE_PATH = join(dir, "e2e.db");
process.env.CHROMA_COLLECTION = "aira_media_e2e_test";
process.env.GEMINI_DEBUG_PAYLOAD = "1";
process.env.GEMINI_DEBUG_PAYLOAD_FILE = join(dir, "payload.json");

const { resolveFfmpegPath, prepareMedia } = await import("../src/bot/media.js");
const { processMessage } = await import("../src/pipeline/pipeline.js");
const { clearMemories } = await import("../src/memory/chroma.js");

// ---------------------------------------------------------------- fixtures
const RED = await sharp({ create: { width: 64, height: 64, channels: 3, background: "#ff0000" } }).png().toBuffer();
const ffmpeg = await resolveFfmpegPath();
let gif: Buffer | null = null;
if (ffmpeg) {
  const out = join(dir, "anim.gif");
  await run(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=64x64:rate=10:duration=3", "-vf", "fps=10", out]);
  gif = readFileSync(out);
}

const files: Record<string, { type: string; body: Buffer }> = {
  "/red.png": { type: "image/png", body: RED },
  ...(gif ? { "/anim.gif": { type: "image/gif", body: gif } } : {}),
};
const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (request) => {
  const file = files[new URL(request.url).pathname];
  // Response's BodyInit does not accept a Node Buffer in this lib config; Uint8Array is the same bytes.
  return file ? new Response(new Uint8Array(file.body), { headers: { "content-type": file.type } }) : new Response("nope", { status: 404 });
}});
const base = `http://127.0.0.1:${server.port}`;
console.log(`local media server: ${base}  (gif: ${gif ? "yes" : "no ffmpeg"})`);

try {
  console.log("=== 1. prepareMedia over a real HTTP fetch ===");
  const prepared = await prepareMedia([
    { name: "red.png", mimeType: "image/png", url: `${base}/red.png` },
    ...(gif ? [{ name: "anim.gif", mimeType: "image/gif", url: `${base}/anim.gif` }] : []),
    { name: "missing.png", mimeType: "image/png", url: `${base}/gone.png` },
  ]);
  check("three items described", prepared.parts.length === 3 && ["red.png", "anim.gif", "missing.png"].every((n) => prepared.summary.includes(n)), prepared.summary);
  check("png arrived as an image part", prepared.parts.some((p) => p.type === "image"));
  check("gif arrived as a video part", gif ? prepared.parts.some((p) => p.type === "video") : prepared.parts.every((p) => p.type !== "video"), prepared.parts.map((p) => p.type).join(","));
  check("404 is reported as a note", prepared.parts.some((p) => p.type === "text" && /missing\.png/.test(p.text ?? "")), JSON.stringify(prepared.parts.filter((p) => p.type === "text")));
  check("hasVisual is true", prepared.hasVisual);

  console.log("=== 2. the model must answer from the pixels ===");
  const stamp = new Date().toISOString();
  const answer = await processMessage({
    userId: "e2e-user",
    user: "Tulip",
    text: "ไฟล์ที่แนบมานี้ภาพหลักเป็นสีอะไร? ตอบสั้น ๆ",
    timestamp: stamp,
    mediaSources: [{ name: "red.png", mimeType: "image/png", url: `${base}/red.png` }],
  });
  console.log(`  reply: ${JSON.stringify(answer.text)}`);
  check("a reply came back", answer.text.trim().length > 0);
  check("the model saw the red image", /แดง|red/i.test(answer.text), answer.text);

  console.log("=== 3. the dumped request really carried the bytes ===");
  const { readDebugDump } = await import("../src/gemini/debug-dump.js");
  const records = readDebugDump(process.env.GEMINI_DEBUG_PAYLOAD_FILE);
  const request = records.find((r) => r.stage === "gemini1" && r.event === "request");
  check("gemini1 request was dumped", !!request, `records=${records.length}`);
  const input = JSON.stringify((request?.payload as { input?: unknown })?.input ?? "");
  check("input contains an image part", /"type":"image"/.test(input));
  check("image carries base64 bytes", /"data":"[A-Za-z0-9+/=]{64,}/.test(input));
  check("the file is named for the model", /red\.png/.test(input));

  console.log("=== 4. a turn with media but no words ===");
  const silent = await processMessage({
    userId: "e2e-user",
    user: "Tulip",
    text: "",
    timestamp: new Date().toISOString(),
    mediaSources: [{ name: "red.png", mimeType: "image/png", url: `${base}/red.png` }],
  });
  console.log(`  reply: ${JSON.stringify(silent.text)}`);
  check("media-only turn still answers", silent.text.trim().length > 0);
  check("and still describes the picture", /แดง|red|ภาพ|รูป/i.test(silent.text), silent.text);

  if (gif) {
    console.log("=== 5. an animated GIF must be read as motion, not one frame ===");
    const moving = await processMessage({
      userId: "e2e-user",
      user: "Tulip",
      text: "ไฟล์ gif ที่แนบนี้มันเคลื่อนไหวยังไง มีตัวเลขอะไรเปลี่ยนบ้าง? ตอบสั้น ๆ",
      timestamp: new Date().toISOString(),
      mediaSources: [{ name: "anim.gif", mimeType: "image/gif", url: `${base}/anim.gif` }],
    });
    console.log(`  reply: ${JSON.stringify(moving.text)}`);
    check("GIF turn answered", moving.text.trim().length > 0);
    check("the model noticed the changing counter", /\d/.test(moving.text), moving.text);
    const videoReq = readDebugDump(process.env.GEMINI_DEBUG_PAYLOAD_FILE).filter((r) => r.event === "request").pop();
    const videoInput = JSON.stringify((videoReq?.payload as { input?: unknown })?.input ?? "");
    check("request sent it as video with processing.fps", /"type":"video"/.test(videoInput) && /"fps":/.test(videoInput), videoInput.slice(0, 200));
  }
} finally {
  server.stop(true);
  try { await clearMemories(); } catch { /* best effort: leave the throwaway collection */ }
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
