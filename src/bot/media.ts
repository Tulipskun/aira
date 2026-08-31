import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import type { Interactions } from "@google/genai";

/**
 * Attachments, custom emojis and stickers are invisible to the model unless the bytes are
 * shipped with the request: `message.attachments` used to be read only for `.name`, and a
 * message with no text was dropped before the pipeline ever saw it.
 *
 * Why GIFs are transcoded (measured against gemini-3.1-flash-lite on 2026-08-31):
 *   - `image/gif` is accepted but decoded as a *single still frame*. A 2-frame red->blue GIF
 *     came back as "solid, static red"; a 5s clip and a 20s clip of the same `testsrc`
 *     animation produced identical answers ("counter 0..9, 10 frames") — the animation was
 *     never seen. Cost: 1064 tokens for that one frame.
 *   - The same content as `video/mp4` is sampled at 1 frame/second and the model reads the
 *     counter correctly (0..4 for 5s, 0..19 for 20s). Cost: 63 tokens per frame.
 *   - Splitting a GIF into frames and sending them as N images costs ~1064 tokens *each*, so
 *     5 frames cost more than the whole video. Video is the only affordable option.
 *   - `processing.fps` is honoured and billed linearly (20s clip: 1260 tokens at the 1fps
 *     default, 6300 at fps=5, 12600 at fps=10), so fps is the dial that bounds cost.
 */

export type MediaItem =
  | { kind: "image"; data: Buffer; mimeType: string; label: string }
  | { kind: "video"; data: Buffer; mimeType: string; label: string; fps?: number }
  | { kind: "audio"; data: Buffer; mimeType: string; label: string }
  | { kind: "document"; data: Buffer; mimeType: string; label: string }
  | { kind: "unsupported"; label: string; reason: string };

export type MediaOptions = {
  maxItems?: number;
  maxBytes?: number;
  /** Frames per second to sample out of a transcoded GIF. */
  gifFps?: number;
  /** Ceiling on sampled frames per GIF, so a long GIF cannot blow the token budget. */
  gifMaxFrames?: number;
};

const DEFAULTS: Required<MediaOptions> = {
  maxItems: 4,
  maxBytes: 8 * 1024 * 1024,
  gifFps: 2,
  gifMaxFrames: 24,
};

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/heic", "image/heif", "image/bmp"]);
const VIDEO_TYPES = new Set(["video/mp4", "video/mpeg", "video/mpg", "video/mov", "video/avi", "video/x-flv", "video/webm", "video/wmv", "video/3gpp"]);
const AUDIO_TYPES = new Set(["audio/mpeg", "audio/mp3", "audio/wav", "audio/x-wav", "audio/aac", "audio/ogg", "audio/flac"]);
const DOCUMENT_TYPES = new Set(["application/pdf", "text/csv"]);

/** discord.js StickerFormatType: PNG=1, APNG=2, Lottie=3, GIF=4. */
// APNG is a PNG container, so reading it as a static PNG (first frame) is honest. Lottie is
// served as .json — claiming image/png for it would ship non-image bytes as if they were a
// picture, so it is labelled by its real type and classifyMedia reports it as unreadable.
const STICKER_MIME: Record<number, string> = { 1: "image/png", 2: "image/png", 3: "application/json", 4: "image/gif" };

/** `<:name:id>` static, `<a:name:id>` animated (served as GIF). */
const CUSTOM_EMOJI_PATTERN = /<a?:[a-zA-Z0-9_]+:\d+>/g;

/**
 * Resolved lazily: `ffmpeg-static` downloads a ~50MB binary in a postinstall, and this host
 * blocks postinstall for some packages. A missing binary must degrade to "GIF as a still
 * image", not crash the message path.
 */
let ffmpegPath: string | null | undefined;
export async function resolveFfmpegPath(): Promise<string | null> {
  if (ffmpegPath !== undefined) return ffmpegPath;
  try {
    const mod = await import("ffmpeg-static");
    const candidate = (mod.default ?? mod) as unknown as string;
    ffmpegPath = typeof candidate === "string" && existsSync(candidate) ? candidate : null;
  } catch {
    ffmpegPath = null;
  }
  return ffmpegPath;
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
}

function isGif(mimeType: string, name: string): boolean {
  return mimeType === "image/gif" || extensionOf(name) === "gif";
}

/**
 * MIME from Discord, falling back to the extension: Discord reports `application/octet-stream`
 * for some uploads, which would otherwise be thrown away as unreadable.
 */
export function effectiveMime(contentType: string | null | undefined, name: string): string {
  const mime = (contentType ?? "").toLowerCase().trim();
  if (mime && mime !== "application/octet-stream") return mime;
  const guess: Record<string, string> = {
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif",
    bmp: "image/bmp", heic: "image/heic", heif: "image/heif",
    mp4: "video/mp4", mov: "video/quicktime", mkv: "video/x-matroska", webm: "video/webm", avi: "video/avi",
    m4a: "audio/mp4", mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", flac: "audio/flac", aac: "audio/aac",
    pdf: "application/pdf", csv: "text/csv",
  };
  return guess[extensionOf(name)] ?? mime ?? "application/octet-stream";
}

/**
 * Duration of an animated GIF in seconds, from libvips' per-frame delays — used to pick an
 * fps that samples the whole clip. Null when libvips cannot read it; the caller then assumes
 * a short clip.
 */
async function gifDuration(data: Buffer): Promise<number | null> {
  try {
    const { default: sharp } = await import("sharp");
    const meta = await sharp(data, { animated: true }).metadata();
    const total = (meta.delay ?? []).reduce((sum, ms) => sum + ms, 0);
    return total ? total / 1000 : null;
  } catch {
    return null;
  }
}

/**
 * GIF -> fragmented MP4 over pipes, no temp files. The plain mp4 muxer refuses a
 * non-seekable output, but `frag_keyframe+empty_moov+default_base_moof` writes a
 * self-contained stream that Gemini accepts inline (verified live).
 *
 * `-pix_fmt yuv420p` matters: without it the encoder emits yuv444p / High 4:4:4.
 * `scale=trunc(iw/2)*2` keeps dimensions even, which h264 requires.
 */
export async function gifToVideo(data: Buffer, fps: number, maxFrames?: number, timeoutMs = 20_000): Promise<Buffer | null> {
  const bin = await resolveFfmpegPath();
  if (!bin) return null;
  return new Promise((resolve) => {
    const child = spawn(bin, [
      "-hide_banner", "-loglevel", "error",
      "-i", "-",
      "-vf", `fps=${fps},scale=trunc(iw/2)*2:trunc(ih/2)*2`,
      "-pix_fmt", "yuv420p",
      "-movflags", "frag_keyframe+empty_moov+default_base_moof",
      // fps cannot go below 1, so a long GIF is bounded by cutting the clip instead of the
      // sampling rate: the model sees the first `maxFrames` seconds rather than an unbounded bill.
      ...(maxFrames && maxFrames > 0 ? ["-frames:v", String(maxFrames)] : []),
      "-an", "-f", "mp4", "pipe:1",
    ], { stdio: ["pipe", "pipe", "pipe"] });

    const chunks: Buffer[] = [];
    let settled = false;
    const done = (value: Buffer | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => { child.kill("SIGKILL"); done(null); }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.on("error", () => done(null));
    child.stdin.on("error", () => done(null));
    child.on("close", (code) => {
      const buf = Buffer.concat(chunks);
      done(code === 0 && buf.length > 0 ? buf : null);
    });
    child.stdin.end(data);
  });
}

/** Decide how to present one downloaded buffer, transcoding GIFs to video. */
export async function classifyMedia(
  raw: { name: string; mimeType: string; data: Buffer },
  options: MediaOptions = {},
): Promise<MediaItem> {
  const opts = { ...DEFAULTS, ...options };
  const { name, mimeType, data } = raw;
  const label = name || mimeType;

  if (isGif(mimeType, name)) {
    const seconds = await gifDuration(data);
    // Sample the whole clip but never bill more than gifMaxFrames: a 2s GIF at 2fps is 4 frames
    // (cheap), a 30s one is cut short rather than charged at 60 x 258 tokens. fps alone cannot do
    // it (its floor is 1 frame/second), so the frame budget also truncates the clip.
    const fps = seconds && seconds > 0
      ? Math.max(1, Math.min(opts.gifFps, opts.gifMaxFrames / seconds))
      : opts.gifFps;
    const budget = seconds ? Math.min(opts.gifMaxFrames, Math.max(1, Math.ceil(seconds * fps))) : undefined;
    const video = await gifToVideo(data, fps, budget);
    if (video) {
      const truncated = seconds !== null && budget !== undefined && seconds * fps > budget + 0.5;
      return {
        kind: "video",
        data: video,
        mimeType: "video/mp4",
        fps,
        label: `${label} (animated GIF${seconds ? `, ${seconds.toFixed(1)}s` : ""} sampled at ${fps.toFixed(2)} fps${truncated ? `, first ${budget} frames only` : ""})`,
      };
    }
    // No ffmpeg available: still better than nothing — the model sees frame one.
    return { kind: "image", data, mimeType: "image/gif", label: `${label} (animated GIF — only the first frame is visible)` };
  }

  if (IMAGE_TYPES.has(mimeType)) return { kind: "image", data, mimeType, label };
  if (VIDEO_TYPES.has(mimeType)) return { kind: "video", data, mimeType, label };
  if (AUDIO_TYPES.has(mimeType)) return { kind: "audio", data, mimeType, label };
  if (DOCUMENT_TYPES.has(mimeType)) return { kind: "document", data, mimeType, label };
  return { kind: "unsupported", label, reason: `${mimeType || "unknown type"} is not readable by the model` };
}

/** discord.js Message surface this module needs — kept structural so tests can fake it. */
export type MediaBearing = {
  content?: string | null;
  attachments?: { values(): Iterable<{ name?: string | null; contentType?: string | null; url: string; proxyURL?: string | null }> };
  stickers?: { values(): Iterable<{ name?: string | null; format: number; url: string }> };
};

/**
 * Where a piece of media lives. Cheap and serialisable, so it can ride along on a
 * ScheduledMessage at receive time while the actual download happens later, at flush
 * time — the message path must not block on network I/O just to light the typing indicator.
 */
export type MediaSource = { name: string; mimeType: string; url: string };

/** Custom emojis referenced in a message, as CDN sources. Animated ones are served as GIF. */
export function parseCustomEmojis(content: string): MediaSource[] {
  const seen = new Set<string>();
  const found: MediaSource[] = [];
  for (const match of content.match(CUSTOM_EMOJI_PATTERN) ?? []) {
    const parsed = /^<a?:([a-zA-Z0-9_]+):(\d+)>$/.exec(match);
    if (!parsed) continue;
    const [, name, id] = parsed;
    if (seen.has(id)) continue;
    seen.add(id);
    const animated = match.startsWith("<a:");
    found.push({
      name: `:${name}:`,
      mimeType: animated ? "image/gif" : "image/png",
      url: `https://cdn.discordapp.com/emojis/${id}.${animated ? "gif" : "png"}`,
    });
  }
  return found;
}

async function fetchBytes(url: string, maxBytes: number): Promise<Buffer | null> {
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength === 0 || bytes.byteLength > maxBytes) return null;
    return Buffer.from(bytes);
  } catch {
    return null;
  }
}

/**
 * Every media source on a message: attachments, then custom emojis, then stickers.
 * Synchronous and network-free by design — this runs on the receive path.
 */
export function mediaSourcesOf(message: MediaBearing): MediaSource[] {
  const sources: MediaSource[] = [];

  for (const attachment of message.attachments?.values() ?? []) {
    const name = attachment.name ?? "attachment";
    sources.push({
      name,
      mimeType: effectiveMime(attachment.contentType, name),
      // proxyURL is the media-proxy endpoint; it works without hotlinking Discord's CDN.
      url: attachment.proxyURL ?? attachment.url,
    });
  }

  sources.push(...parseCustomEmojis(message.content ?? ""));

  for (const sticker of message.stickers?.values() ?? []) {
    sources.push({
      name: sticker.name || "sticker",
      mimeType: STICKER_MIME[sticker.format] ?? "image/png",
      url: sticker.url,
    });
  }

  return sources;
}

/**
 * Download and prepare media for the model. Order is preserved and the count capped,
 * because every item is inlined as base64 in the request body.
 */
export async function collectMedia(sources: MediaSource[], options: MediaOptions = {}): Promise<MediaItem[]> {
  const opts = { ...DEFAULTS, ...options };
  const items: MediaItem[] = [];
  for (const candidate of sources.slice(0, opts.maxItems)) {
    const data = await fetchBytes(candidate.url, opts.maxBytes);
    if (!data) {
      items.push({ kind: "unsupported", label: candidate.name, reason: "could not be downloaded" });
      continue;
    }
    items.push(await classifyMedia({ name: candidate.name, mimeType: candidate.mimeType, data }, opts));
  }
  return items;
}

/**
 * Media parts for the Interactions request. `messageStep()` already emits a JSON text part
 * describing the turn; these are appended after it so the model reads the description first
 * and then looks at the bytes.
 */
export function mediaToContent(items: MediaItem[]): Interactions.Content[] {
  const parts: Interactions.Content[] = [];
  for (const item of items) {
    switch (item.kind) {
      case "image":
        parts.push({ type: "image", data: item.data.toString("base64"), mime_type: item.mimeType });
        break;
      case "video":
        parts.push({
          type: "video",
          data: item.data.toString("base64"),
          mime_type: item.mimeType,
          ...(item.fps ? { processing: { type: "static", fps: item.fps } } : {}),
        });
        break;
      case "audio":
        parts.push({ type: "audio", data: item.data.toString("base64"), mime_type: item.mimeType });
        break;
      case "document":
        parts.push({ type: "document", data: item.data.toString("base64"), mime_type: item.mimeType });
        break;
      case "unsupported":
        // Tell the model the file existed instead of silently dropping it.
        parts.push({ type: "text", text: `[${item.label} — ${item.reason}]` });
        break;
    }
  }
  return parts;
}

/** Compact note about what was attached, stored with the turn so history keeps the fact. */
export function mediaSummary(items: MediaItem[]): string {
  if (!items.length) return "";
  return items
    .map((item) => (item.kind === "unsupported" ? `${item.label} (${item.reason})` : `${item.label} [${item.kind}]`))
    .join(", ");
}

export type PreparedMedia = {
  /** Content parts to append to the user turn (empty when there was nothing usable). */
  parts: Interactions.Content[];
  /** One-line description for `fileName`, e.g. "photo.jpg [image], notes.txt". */
  summary: string;
  /** True when at least one item reached the model as real bytes. */
  hasVisual: boolean;
};

/**
 * One call site for the pipeline: fetch, classify, convert, and serialise everything a
 * message carries. Failures are already folded into `unsupported` items, so this never throws.
 */
export async function prepareMedia(sources: MediaSource[]): Promise<PreparedMedia> {
  if (!sources.length) return { parts: [], summary: "", hasVisual: false };
  const items = await collectMedia(sources);
  return {
    parts: mediaToContent(items),
    summary: mediaSummary(items),
    hasVisual: items.some((item) => item.kind !== "unsupported"),
  };
}
