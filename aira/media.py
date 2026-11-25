from __future__ import annotations

import asyncio
import base64
import io
import logging
import mimetypes
import re
import shutil
from dataclasses import dataclass
from urllib.parse import urlparse

import aiohttp
from PIL import Image, ImageOps

log = logging.getLogger("aira.media")

MAX_MEDIA_BYTES = 8 * 1024 * 1024
MAX_MEDIA_ITEMS = 4
MAX_TEXT_CHARS = 24_000
MAX_IMAGE_EDGE = 1500
GIF_FPS = 2
GIF_MAX_FRAMES = 24
CUSTOM_EMOJI_PATTERN = re.compile(r"<a?:([a-zA-Z0-9_]+):(\d+)>")
ALLOWED_MEDIA_HOSTS = ("discordapp.com", "discordapp.net", "discord.media")
DOCUMENT_TYPES = {
    "application/pdf", "text/csv",
}
IMAGE_TYPES = {"image/png", "image/jpeg", "image/webp", "image/heic", "image/heif", "image/bmp"}
VIDEO_TYPES = {
    "video/mp4", "video/mpeg", "video/mpg", "video/quicktime", "video/x-matroska",
    "video/webm", "video/x-flv", "video/avi", "video/wmv", "video/3gpp",
}
AUDIO_TYPES = {
    "audio/mpeg", "audio/mp3", "audio/wav", "audio/x-wav", "audio/aac",
    "audio/mp4", "audio/m4a", "audio/ogg", "audio/flac", "audio/webm", "audio/vnd.wave",
}
TEXT_TYPES = {
    "text/plain", "text/markdown", "text/html", "text/css", "text/javascript",
    "text/xml", "text/yaml", "text/csv", "application/json", "application/xml",
    "application/javascript", "application/x-yaml", "application/sql", "application/x-sh",
    "application/toml",
}
EXTENSION_MIME = {
    "png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "webp": "image/webp",
    "gif": "image/gif", "bmp": "image/bmp", "heic": "image/heic", "heif": "image/heif",
    "mp4": "video/mp4", "mov": "video/quicktime", "mkv": "video/x-matroska",
    "webm": "video/webm", "avi": "video/avi", "m4v": "video/mp4",
    "m4a": "audio/mp4", "mp3": "audio/mpeg", "wav": "audio/wav", "ogg": "audio/ogg",
    "flac": "audio/flac", "aac": "audio/aac", "pdf": "application/pdf", "csv": "text/csv",
    "txt": "text/plain", "log": "text/plain", "md": "text/markdown", "html": "text/html",
    "htm": "text/html", "css": "text/css", "js": "text/javascript", "mjs": "text/javascript",
    "cjs": "text/javascript", "ts": "text/javascript", "tsx": "text/javascript",
    "jsx": "text/javascript", "json": "application/json", "xml": "text/xml",
    "yaml": "text/yaml", "yml": "text/yaml", "sql": "application/sql",
    "sh": "application/x-sh", "bash": "application/x-sh", "toml": "application/toml",
}


def _allowed_url(url: str) -> bool:
    parsed = urlparse(url)
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password:
        return False
    host = parsed.hostname.lower().rstrip(".")
    return any(host == domain or host.endswith("." + domain) for domain in ALLOWED_MEDIA_HOSTS)


def _effective_mime(content_type: str | None, filename: str) -> str:
    mime = (content_type or "").split(";", 1)[0].strip().lower()
    if mime and mime != "application/octet-stream":
        return mime
    extension = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
    return EXTENSION_MIME.get(extension) or mime or mimetypes.guess_type(filename)[0] or "application/octet-stream"


def _sniff_mime(data: bytes) -> str | None:
    if len(data) >= 12 and data[:6] in (b"GIF87a", b"GIF89a"):
        return "image/gif"
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if data.startswith(b"RIFF") and data[8:12] == b"WEBP":
        return "image/webp"
    if data.startswith(b"%PDF-"):
        return "application/pdf"
    if data.startswith(b"OggS"):
        return "audio/ogg"
    if data.startswith(b"ID3") or data[:2] in (b"\xff\xfb", b"\xff\xf3", b"\xff\xf2"):
        return "audio/mpeg"
    if data.startswith(b"\x1aE\xdf\xa3"):
        return "video/webm"
    if len(data) > 12 and data[4:8] == b"ftyp":
        return "video/quicktime" if data[8:12] == b"qt  " else "video/mp4"
    if data.startswith(b"RIFF") and data[8:12] == b"WAVE":
        return "audio/wav"
    return None


def _looks_binary(data: bytes) -> bool:
    return b"\x00" in data[:1024]


def _image_for_model(data: bytes, mime: str) -> tuple[bytes, str]:
    try:
        with Image.open(io.BytesIO(data)) as source:
            if getattr(source, "is_animated", False):
                source.seek(0)
            image = ImageOps.exif_transpose(source.copy())
            image.thumbnail((MAX_IMAGE_EDGE, MAX_IMAGE_EDGE), Image.Resampling.LANCZOS)
            if image.mode not in ("RGB", "RGBA"):
                image = image.convert("RGBA" if "A" in image.getbands() else "RGB")
            output = io.BytesIO()
            out_mime = "image/png" if image.mode == "RGBA" else "image/jpeg"
            image.save(
                output, format="PNG" if out_mime == "image/png" else "JPEG",
                quality=90, optimize=True,
            )
            return output.getvalue(), out_mime
    except Exception:
        return data, mime


def _ffmpeg_binary() -> str | None:
    binary = shutil.which("ffmpeg")
    if binary:
        return binary
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except (ImportError, RuntimeError, OSError):
        log.warning("FFmpeg is unavailable; animated GIFs will be sent as still images")
        return None


def _gif_duration(data: bytes) -> float | None:
    try:
        with Image.open(io.BytesIO(data)) as image:
            count = getattr(image, "n_frames", 1)
            total = 0
            for frame in range(count):
                image.seek(frame)
                total += int(image.info.get("duration", 0) or 0)
            return total / 1000 if total else None
    except Exception:
        return None


async def _gif_to_video(data: bytes, fps: float, max_frames: int | None) -> bytes | None:
    binary = _ffmpeg_binary()
    if not binary:
        return None
    args = [
        binary, "-hide_banner", "-loglevel", "error", "-i", "pipe:0",
        "-vf", f"fps={fps:.4f},scale='min(1500,iw)':'min(1500,ih)':force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2",
        "-pix_fmt", "yuv420p", "-fs", str(MAX_MEDIA_BYTES * 2),
        "-movflags", "frag_keyframe+empty_moov+default_base_moof",
    ]
    if max_frames:
        args.extend(["-frames:v", str(max_frames)])
    args.extend(["-an", "-f", "mp4", "pipe:1"])
    try:
        process = await asyncio.create_subprocess_exec(
            *args, stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )
        output, _ = await asyncio.wait_for(process.communicate(data), timeout=20)
        return output if process.returncode == 0 and output else None
    except (OSError, asyncio.TimeoutError):
        log.debug("GIF-to-video conversion unavailable; sending first frame", exc_info=True)
        return None


@dataclass
class PreparedMedia:
    parts: list[dict]
    summary: str
    file_names: list[str]
    has_visual: bool = False


def _custom_emoji_sources(content: str) -> list[dict]:
    found, seen = [], set()
    for match in CUSTOM_EMOJI_PATTERN.finditer(content or ""):
        name, emoji_id = match.groups()
        if emoji_id in seen:
            continue
        seen.add(emoji_id)
        animated = match.group(0).startswith("<a:")
        found.append({
            "filename": f":{name}:", "content_type": "image/gif" if animated else "image/png",
            "url": f"https://cdn.discordapp.com/emojis/{emoji_id}.{'gif' if animated else 'png'}",
            "size": 0,
        })
    return found


def _embed_sources(embeds) -> list[dict]:
    found = []
    for embed in embeds or []:
        candidates = []
        video = getattr(embed, "video", None)
        image = getattr(embed, "image", None)
        thumbnail = getattr(embed, "thumbnail", None)
        if video:
            candidates.append((video, "video/mp4"))
        elif image:
            candidates.append((image, None))
        elif thumbnail:
            candidates.append((thumbnail, None))
        for item, fixed_mime in candidates:
            url = getattr(item, "proxy_url", None) or getattr(item, "url", None)
            if not url or not _allowed_url(str(url)):
                continue
            filename = str(url).split("?", 1)[0].rsplit("/", 1)[-1] or "link-preview"
            mime = fixed_mime or _effective_mime(None, filename)
            found.append({
                "filename": filename, "content_type": mime, "url": str(url), "size": 0,
            })
    return found


async def _fetch_source(session: aiohttp.ClientSession, source: dict) -> tuple[bytes | None, bool]:
    primary = str(source.get("proxy_url") or source.get("url") or "")
    fallback = str(source.get("url") or "")
    urls = [primary]
    if fallback and fallback != primary and _allowed_url(fallback):
        urls.append(fallback)
    for url in urls:
        if not _allowed_url(url):
            continue
        try:
            async with session.get(url, allow_redirects=False) as response:
                if response.status != 200:
                    continue
                declared = response.content_length
                if declared is not None and declared > MAX_MEDIA_BYTES:
                    return None, True
                data = await response.content.read(MAX_MEDIA_BYTES + 1)
                if len(data) > MAX_MEDIA_BYTES:
                    return None, True
                if data:
                    return data, False
        except (aiohttp.ClientError, TimeoutError, ValueError):
            continue
    return None, False


async def prepare_attachments(attachments, content: str = "", embeds=None) -> PreparedMedia:
    sources = list(attachments or [])
    sources.extend(_custom_emoji_sources(content))
    sources.extend(_embed_sources(embeds))
    # Keep the original order (attachments, custom emojis, stickers, then Discord link previews).
    sources = sources[:MAX_MEDIA_ITEMS]
    if not sources:
        return PreparedMedia([], "", [], False)

    parts: list[dict] = []
    descriptions: list[str] = []
    names: list[str] = []
    has_visual = False
    timeout = aiohttp.ClientTimeout(total=30, connect=10)
    connector = aiohttp.TCPConnector(limit=4, ttl_dns_cache=60)

    async with aiohttp.ClientSession(timeout=timeout, connector=connector) as session:
        for source in sources:
            filename = str(getattr(source, "filename", getattr(source, "name", "attachment")) or "attachment")
            primary_url = str(getattr(source, "proxy_url", None) or getattr(source, "url", "") or "")
            fallback_url = str(getattr(source, "url", "") or "")
            mime = _effective_mime(getattr(source, "content_type", None), filename)
            size = int(getattr(source, "size", 0) or 0)
            if not _allowed_url(primary_url):
                descriptions.append(f"{filename} (host not allowed)")
                parts.append({"type": "text", "text": f"[{filename} — source host not allowed]"})
                continue
            if size > MAX_MEDIA_BYTES:
                descriptions.append(f"{filename} (file is too large to read)")
                parts.append({"type": "text", "text": f"[{filename} — file is too large to read]"})
                continue
            data, too_large = await _fetch_source(session, {
                "proxy_url": primary_url, "url": fallback_url,
            })
            if too_large:
                descriptions.append(f"{filename} (file is too large to read)")
                parts.append({"type": "text", "text": f"[{filename} — file is too large to read]"})
                continue
            if data is None:
                descriptions.append(f"{filename} (could not be downloaded)")
                parts.append({"type": "text", "text": f"[{filename} — could not be downloaded]"})
                continue

            actual = _sniff_mime(data)
            if actual:
                mime = actual

            if mime == "image/gif":
                seconds = _gif_duration(data)
                fps = max(1.0, min(float(GIF_FPS), GIF_MAX_FRAMES / seconds)) if seconds and seconds > 0 else float(GIF_FPS)
                budget = min(GIF_MAX_FRAMES, max(1, int((seconds * fps) + 0.999))) if seconds else None
                video = await _gif_to_video(data, fps, budget)
                if video:
                    truncated = bool(seconds and budget and seconds * fps > budget + 0.5)
                    parts.append({
                        "type": "video", "data": base64.b64encode(video).decode("ascii"),
                        "mime_type": "video/mp4",
                        "processing": {"type": "static", "fps": fps},
                    })
                    descriptions.append(f"{filename} [video; animated GIF sampled at {fps:.2f} fps" + (f"; first {budget} frames" if truncated else "") + "]")
                    names.append(filename)
                    has_visual = True
                    continue
                try:
                    with Image.open(io.BytesIO(data)) as gif:
                        gif.seek(0)
                        still = io.BytesIO()
                        gif.convert("RGBA").save(still, format="PNG")
                        data, mime = still.getvalue(), "image/png"
                except Exception:
                    descriptions.append(f"{filename} (animated GIF could not be decoded)")
                    parts.append({"type": "text", "text": f"[{filename} — animated GIF could not be decoded]"})
                    continue

            if mime in IMAGE_TYPES or mime == "image/gif":
                data, mime = _image_for_model(data, mime)
                parts.append({"type": "image", "data": base64.b64encode(data).decode("ascii"), "mime_type": mime})
                descriptions.append(f"{filename} [image]")
                names.append(filename)
                has_visual = True
            elif mime in VIDEO_TYPES:
                parts.append({"type": "video", "data": base64.b64encode(data).decode("ascii"), "mime_type": mime})
                descriptions.append(f"{filename} [video]")
                names.append(filename)
                has_visual = True
            elif mime in AUDIO_TYPES:
                parts.append({"type": "audio", "data": base64.b64encode(data).decode("ascii"), "mime_type": mime})
                descriptions.append(f"{filename} [audio]")
                names.append(filename)
            elif mime in DOCUMENT_TYPES:
                parts.append({"type": "document", "data": base64.b64encode(data).decode("ascii"), "mime_type": mime})
                descriptions.append(f"{filename} [document]")
                names.append(filename)
            elif mime in TEXT_TYPES:
                if _looks_binary(data):
                    descriptions.append(f"{filename} ({mime} but the bytes are not readable text)")
                    parts.append({"type": "text", "text": f"[{filename} — file content is not readable text]"})
                    continue
                text = data.decode("utf-8-sig", errors="replace").replace("\r\n", "\n")
                truncated = len(text) > MAX_TEXT_CHARS
                text = text[:MAX_TEXT_CHARS]
                parts.append({
                    "type": "text",
                    "text": f"--- attached file: {filename} ({mime}, {len(text)} characters{' , truncated' if truncated else ''}) ---\n{text}"
                            f"{'\n[truncated]' if truncated else ''}\n--- end of file ---",
                })
                descriptions.append(f"{filename} [text]")
                names.append(filename)
            elif mime == "application/lottie":
                descriptions.append(f"{filename} (animated Lottie sticker cannot be displayed)")
                parts.append({"type": "text", "text": f"[{filename} — animated Lottie sticker cannot be displayed]"})
            else:
                descriptions.append(f"{filename} ({mime or 'unknown type'} is not readable by the model)")
                parts.append({"type": "text", "text": f"[{filename} — {mime or 'unknown type'} is not readable by the model]"})

    return PreparedMedia(parts, ", ".join(descriptions), names, has_visual)
