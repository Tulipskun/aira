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
  /**
   * Source/markup/data file sent as readable text. Distinct from `document` because the bytes
   * never leave this process as an upload: the model sees the characters. Only the label reaches
   * the stored history row (via `mediaSummary`), never the file's contents — see `Message.media`,
   * which is appended to the current turn only.
   */
  | { kind: "text"; mimeType: string; label: string; text: string; truncated: boolean }
  | { kind: "unsupported"; label: string; reason: string };

export type MediaOptions = {
  maxItems?: number;
  maxBytes?: number;
  /** Character ceiling for a `text` item; the rest is cut with an explicit marker. */
  maxTextChars?: number;
  /** Frames per second to sample out of a transcoded GIF. */
  gifFps?: number;
  /** Ceiling on sampled frames per GIF, so a long GIF cannot blow the token budget. */
  gifMaxFrames?: number;
  /**
   * Gate on which URLs may be fetched. Defaults to Discord's own CDN/proxies only. Injectable
   * so tests can point at a loopback fixture without weakening the production rule.
   */
  allowUrl?: (url: string) => boolean;
};

const DEFAULTS: Required<MediaOptions> = {
  maxItems: 4,
  maxBytes: 8 * 1024 * 1024,
  maxTextChars: 24_000,
  gifFps: 2,
  gifMaxFrames: 24,
  allowUrl: allowedUrl,
};

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/heic", "image/heif", "image/bmp"]);
// Every string here is one this code can actually produce (from Discord's contentType, from
// effectiveMime's extension table, or from sniffMime) and was sent to the live API: .mov, .mkv and
// .webm all decoded correctly. video/quicktime and video/x-matroska were previously missing even
// though sniffMime/effectiveMime emit them, so those uploads were thrown away as unreadable.
const VIDEO_TYPES = new Set(["video/mp4", "video/mpeg", "video/mpg", "video/quicktime", "video/x-matroska", "video/webm", "video/x-flv", "video/avi", "video/wmv", "video/3gpp"]);
// audio/mp4 is what a .m4a upload resolves to; audio/webm is what a voice-message attachment can
// carry. Both verified. audio/mp4 was missing, so .m4a fell through to "unsupported".
const AUDIO_TYPES = new Set(["audio/mpeg", "audio/mp3", "audio/wav", "audio/x-wav", "audio/aac", "audio/mp4", "audio/ogg", "audio/flac", "audio/webm", "audio/vnd.wave"]);
// Binary documents the API parses for us. Verified: a valid one-page PDF reads back its text.
const DOCUMENT_TYPES = new Set(["application/pdf", "text/csv"]);
/**
 * Source, markup and data files. These are decoded and sent as a **text part** rather than a
 * `document` part because we can cap and label the content ourselves: a 10MB log survives as the
 * first `maxTextChars` with an explicit `truncated` marker, where a document part would either
 * fail the size limit outright or bill the whole file. (Both kinds are equally current-turn only
 * in history — `Message.media` is never replayed — so that is *not* the reason.) The API does
 * accept html/js/json/md/css as documents; verified reading them correctly.
 */
const TEXT_TYPES = new Set([
  "text/plain", "text/markdown", "text/html", "text/css", "text/javascript", "text/xml", "text/yaml", "text/csv",
  "application/json", "application/xml", "application/javascript", "application/x-yaml", "application/sql", "application/x-sh",
]);

/** discord.js StickerFormatType: PNG=1, APNG=2, Lottie=3, GIF=4. */
// APNG is a PNG container, so reading it as a static PNG (first frame) is honest. Lottie is
// served as .json — claiming image/png for it would ship non-image bytes as if they were a
// picture. It gets its own label rather than application/json because a Lottie file *is* JSON and
// would otherwise be sent as a text attachment: vector path data is not something she can look
// at, and tens of kilobytes of it is pure token cost with no understanding gained.
const STICKER_MIME: Record<number, string> = { 1: "image/png", 2: "image/png", 3: "application/lottie", 4: "image/gif" };

/** Friendlier wording for the refusal the model and the history row see. */
const UNSUPPORTED_HINTS: Record<string, string> = {
  "application/lottie": "an animated (Lottie) sticker, which cannot be displayed",
};

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
    // Text and source files. Discord reports `application/octet-stream` for nearly all of these,
    // so without a mapping they would be discarded even though the model reads them. Only mimes
    // that classifyMedia actually handles are listed here.
    txt: "text/plain", log: "text/plain", md: "text/markdown", html: "text/html", htm: "text/html",
    css: "text/css", js: "text/javascript", mjs: "text/javascript", cjs: "text/javascript",
    ts: "text/javascript", tsx: "text/javascript", jsx: "text/javascript",
    json: "application/json", xml: "text/xml", yaml: "text/yaml", yml: "text/yaml",
    sql: "application/sql", sh: "application/x-sh", bash: "application/x-sh",
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

/**
 * What the bytes actually are, from their magic numbers. The declared mime type cannot be
 * trusted for link-embed media: Discord's proxy serves an unfurl's `image` as whatever the
 * provider advertised, and GIFs that Discord already transcoded to MP4 come back labelled
 * `image/png` from a `.gif`-looking path. Getting this wrong silently costs the animation
 * (see the header note: image/gif is decoded as one still frame).
 */
export function sniffMime(data: Buffer): string | null {
  if (data.length < 12) return null;
  const head = data.subarray(0, 12);
  const ascii = (o: number, n: number): string => data.subarray(o, o + n).toString("latin1");
  if (ascii(0, 6) === "GIF87a" || ascii(0, 6) === "GIF89a") return "image/gif";
  if (head[0] === 0x89 && ascii(1, 3) === "PNG") return "image/png";
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "image/jpeg";
  if (ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") {
    const fourcc = ascii(12, 4);
    if (fourcc === "VP8X") {
      // Only a VP8X chunk with the animation flag set is an animated WebP.
      const flags = data.length > 20 ? data[20] : 0;
      return flags & 0x02 ? "image/gif" : "image/webp";
    }
    return "image/webp";
  }
  if (ascii(4, 4) === "ftyp") {
    const brand = ascii(8, 3);
    if (brand === "qt ") return "video/quicktime";
    return "video/mp4";
  }
  if (ascii(0, 4) === "OggS") return "audio/ogg";
  if (ascii(0, 4) === "%PDF") return "application/pdf";
  return null;
}

/**
 * Hosts we are willing to download media from. Deliberately only Discord's own CDN and its
 * external-content proxies: a user must never be able to make this process fetch an arbitrary
 * URL (internal services, localhost, cloud metadata). Discord has already fetched and proxied
 * anything reachable from a link embed, so `proxyURL` is both safe and cache-friendly.
 */
const ALLOWED_MEDIA_HOSTS = /(^\.|\.)(discordapp\.com|discordapp\.net|discord\.media)$/i;

export function isDiscordMediaUrl(url: string): boolean {
  try {
    const { protocol, hostname } = new URL(url);
    return (protocol === "https:" || protocol === "http:") && ALLOWED_MEDIA_HOSTS.test(hostname);
  } catch {
    return false;
  }
}

/**
 * Escape hatch for tests and self-hosted fixtures: `ISLA_MEDIA_EXTRA_HOSTS` is a comma-separated
 * hostname list added to the allowlist. Read per call (not cached at module load) so a test can
 * set it after import. Never set this to a wildcard on a public host — it is exactly the SSRF
 * door the allowlist exists to close.
 */
function allowedUrl(url: string): boolean {
  if (isDiscordMediaUrl(url)) return true;
  const extra = (process.env.ISLA_MEDIA_EXTRA_HOSTS ?? "")
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
  if (!extra.length) return false;
  try {
    const { protocol, hostname } = new URL(url);
    return (protocol === "https:" || protocol === "http:") && extra.includes(hostname);
  } catch {
    return false;
  }
}

/** Decide how to present one downloaded buffer, transcoding GIFs to video. */
export async function classifyMedia(
  raw: { name: string; mimeType: string; data: Buffer },
  options: MediaOptions = {},
): Promise<MediaItem> {
  const opts = { ...DEFAULTS, ...options };
  const { name, data } = raw;
  // The declared mime is the primary signal; the bytes only override it where a wrong label is
  // actually harmful: a Discord `gifv` proxy path ends in `.gif` while carrying MP4 (feeding that
  // to the transcoder loses the animation), and a generic `application/octet-stream` tells us
  // nothing. Anything else keeps its declared type, so a caller that says "video" is believed.
  const sniffed = sniffMime(data);
  const declaredIsGif = isGif(raw.mimeType, name);
  const declaredIsVague = !raw.mimeType || raw.mimeType === "application/octet-stream" || raw.mimeType === "application/unknown";
  // Bytes beat the name; the name beats a vague declared type. Resolving the extension *here*
  // rather than trusting the caller matters: mediaSourcesOf() pre-resolves it, but classifyMedia
  // is also called directly (tests, future callers), and an unresolved octet-stream would silently
  // discard a perfectly readable .txt.
  const mimeType = sniffed && (declaredIsGif ? sniffed !== "image/gif" : declaredIsVague) ? sniffed : effectiveMime(raw.mimeType, name);
  const label = name || mimeType;

  // When the bytes identified themselves, ignore the filename: a Discord `gifv` proxy path ends
  // in `.gif` while carrying MP4, and treating that as a GIF would feed video bytes to the
  // transcoder.
  if (isGif(mimeType, sniffed ? "" : name)) {
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
  if (TEXT_TYPES.has(mimeType)) {
    // A file that claims to be text but is mostly opaque bytes (a mislabelled upload, a UTF-16
    // dump, a binary pretending to be a .txt) would reach the model as mojibake. Refuse honestly
    // instead — the same rule that keeps a Lottie sticker out of the image path.
    if (looksBinary(data)) {
      return { kind: "unsupported", label, reason: `${mimeType} but the bytes are not readable text` };
    }
    const full = data.toString("utf8").replace(/\r\n/g, "\n");
    const truncated = full.length > opts.maxTextChars;
    return {
      kind: "text",
      mimeType,
      label,
      text: truncated ? full.slice(0, opts.maxTextChars) : full,
      truncated,
    };
  }
  const hint = UNSUPPORTED_HINTS[mimeType];
  return {
    kind: "unsupported",
    label,
    reason: hint ? `${label} is ${hint}` : `${mimeType || "unknown type"} is not readable by the model`,
  };
}

/**
 * NUL bytes are the reliable signal: every text encoding we accept, including UTF-8/UTF-16 with a
 * BOM, has none in its first kilobyte, while almost every binary format does.
 */
export function looksBinary(data: Buffer): boolean {
  const window = data.subarray(0, 1024);
  return window.includes(0);
}

/** discord.js Message surface this module needs — kept structural so tests can fake it. */
export type MediaBearing = {
  content?: string | null;
  attachments?: { values(): Iterable<{ name?: string | null; contentType?: string | null; url: string; proxyURL?: string | null }> };
  stickers?: { values(): Iterable<{ name?: string | null; format: number; url: string }> };
  /**
   * Link unfurls. Discord has already fetched, proxied and (for `gifv`) transcoded the external
   * content, so reading these URLs is safe and adds no third-party request from this host.
   */
  embeds?: {
    values(): Iterable<{
      image?: { url: string; proxyURL?: string | null } | null;
      video?: { url: string; proxyURL?: string | null } | null;
      thumbnail?: { url: string; proxyURL?: string | null } | null;
      url?: string | null;
    }>;
  };
};

/**
 * Where a piece of media lives. Cheap and serialisable, so it can ride along on a
 * ScheduledMessage at receive time while the actual download happens later, at flush
 * time — the message path must not block on network I/O just to light the typing indicator.
 */
export type MediaSource = {
  name: string;
  mimeType: string;
  url: string;
  /**
   * Second URL to try when `url` fails. Discord's media proxy answers **415 Unsupported Media
   * Type** for everything it will not render as media — measured: html, txt, md, json, css, js,
   * xml, yaml, sql, sh, svg, csv and **pdf** all 415, while the same object on
   * `cdn.discordapp.com` returns 200. Images, GIFs and mp4 pass through the proxy fine, so the
   * proxy stays first (cache-friendly, works when hotlinking is blocked) and this carries the
   * direct CDN URL for the rest.
   */
  fallbackUrl?: string;
};

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

async function fetchBytes(url: string, maxBytes: number): Promise<{ data: Buffer } | { tooLarge: true } | null> {
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength === 0) return null;
    // Separate from "unreachable": a 20MB video and a dead link need different words, and for a
    // text file this is the one case where the content was fine and only the size was not.
    if (bytes.byteLength > maxBytes) return { tooLarge: true };
    return { data: Buffer.from(bytes) };
  } catch {
    return null;
  }
}

/**
 * Fetch a source, retrying on `fallbackUrl` when the primary URL refuses it. The proxy's 415 is
 * not a dead link — the object exists and the direct CDN URL serves it — so without this every
 * text/source and PDF attachment is discarded as "could not be downloaded" (see MediaSource).
 */
async function fetchSource(source: MediaSource, maxBytes: number): Promise<{ data: Buffer } | { tooLarge: true } | null> {
  const primary = await fetchBytes(source.url, maxBytes);
  if (primary || !source.fallbackUrl || source.fallbackUrl === source.url) return primary;
  return fetchBytes(source.fallbackUrl, maxBytes);
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
      // proxyURL is the media-proxy endpoint; it works without hotlinking Discord's CDN. But the
      // proxy 415s anything it does not treat as media (text, source, PDF), so keep the direct
      // CDN URL as the retry target.
      url: attachment.proxyURL ?? attachment.url,
      fallbackUrl: attachment.proxyURL && attachment.proxyURL !== attachment.url ? attachment.url : undefined,
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

  // Link unfurls: a klipy/tenor/giphy GIF link is not an attachment, but Discord has already
  // fetched it and exposes a proxied `video` (mp4, for gifv providers) or `image`. One source per
  // embed, best first — taking image *and* thumbnail would double-bill the same clip.
  // No fallbackUrl here on purpose: the unprefixed URL is the third-party host, and never
  // fetching it is the whole point of reading embeds instead of the link the user typed.
  for (const embed of message.embeds?.values() ?? []) {
    const picked = embed.video ?? embed.image ?? embed.thumbnail;
    if (!picked) continue;
    const url = picked.proxyURL ?? picked.url;
    if (!url || !isDiscordMediaUrl(url)) continue;
    const base = url.split("/").pop() ?? "embed";
    sources.push({
      name: embed.url ? `${new URL(embed.url).hostname}/${base}` : base,
      mimeType: embed.video ? "video/mp4" : effectiveMime(null, base),
      url,
    });
  }

  return dedupeSources(sources);
}

/** Same bytes reached twice (attachment + its embed, or a repeated emoji) — keep the first. */
function dedupeSources(sources: MediaSource[]): MediaSource[] {
  const seen = new Set<string>();
  return sources.filter((source) => {
    const key = source.url.split("?")[0];
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Download and prepare media for the model. Order is preserved and the count capped,
 * because every item is inlined as base64 in the request body.
 */
export async function collectMedia(sources: MediaSource[], options: MediaOptions = {}): Promise<MediaItem[]> {
  const opts = { ...DEFAULTS, ...options };
  const items: MediaItem[] = [];
  for (const candidate of sources.slice(0, opts.maxItems)) {
    if (!opts.allowUrl(candidate.url)) {
      items.push({ kind: "unsupported", label: candidate.name, reason: "host not allowed" });
      continue;
    }
    // The fallback is a second URL and gets the same gate: a caller that only validated `url`
    // must not be able to smuggle an internal address through `fallbackUrl`. When it fails the
    // gate the source is still worth trying once — for a link embed `fallbackUrl` is the
    // third-party host, which is *expected* to be refused, so drop the retry rather than the file.
    const source: MediaSource =
      candidate.fallbackUrl && !opts.allowUrl(candidate.fallbackUrl)
        ? { ...candidate, fallbackUrl: undefined }
        : candidate;
    const fetched = await fetchSource(source, opts.maxBytes);
    if (!fetched) {
      items.push({ kind: "unsupported", label: candidate.name, reason: "could not be downloaded" });
      continue;
    }
    if ("tooLarge" in fetched) {
      items.push({ kind: "unsupported", label: candidate.name, reason: "file is too large to read" });
      continue;
    }
    items.push(await classifyMedia({ name: candidate.name, mimeType: candidate.mimeType, data: fetched.data }, opts));
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
      case "text":
        // Delimiters rather than a markdown fence: file content can itself contain ```, and the
        // model must not mistake the closing marker for part of the source.
        parts.push({
          type: "text",
          text: [
            `--- attached file: ${item.label} (${item.mimeType}, ${item.text.length} characters${item.truncated ? ", truncated" : ""}) ---`,
            item.text,
            "--- end of file ---",
          ].join("\n"),
        });
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
export async function prepareMedia(sources: MediaSource[], options: MediaOptions = {}): Promise<PreparedMedia> {
  if (!sources.length) return { parts: [], summary: "", hasVisual: false };
  const items = await collectMedia(sources, options);
  return {
    parts: mediaToContent(items),
    summary: mediaSummary(items),
    hasVisual: items.some((item) => item.kind !== "unsupported"),
  };
}
