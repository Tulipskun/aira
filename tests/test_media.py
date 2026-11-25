import io
import unittest
from unittest.mock import patch
from types import SimpleNamespace

from PIL import Image

from aira.media import (
    MAX_MEDIA_ITEMS, _allowed_url, _custom_emoji_sources, _effective_mime,
    _ffmpeg_binary, _gif_duration, _image_for_model, _looks_binary, _sniff_mime,
)


class MediaTests(unittest.TestCase):
    def test_url_allowlist_requires_https_and_exact_discord_hosts(self):
        self.assertTrue(_allowed_url("https://cdn.discordapp.com/attachments/1/2/a.png"))
        self.assertTrue(_allowed_url("https://media.discordapp.net/attachments/1/2/a.png"))
        self.assertFalse(_allowed_url("http://cdn.discordapp.com/a.png"))
        self.assertFalse(_allowed_url("https://cdn.discordapp.com.attacker.example/a.png"))
        self.assertFalse(_allowed_url("https://127.0.0.1/a.png"))

    def test_mime_resolution_and_sniffing(self):
        self.assertEqual(_effective_mime("application/octet-stream", "report.pdf"), "application/pdf")
        self.assertEqual(_sniff_mime(b"%PDF-1.7"), "application/pdf")
        self.assertEqual(_sniff_mime(b"\x89PNG\r\n\x1a\nrest"), "image/png")
        self.assertIsNone(_sniff_mime(b"unknown"))

    def test_binary_text_guard(self):
        self.assertFalse(_looks_binary(b"valid utf8 text"))
        self.assertTrue(_looks_binary(b"bad\x00text"))

    def test_custom_emoji_sources_are_deduplicated(self):
        items = _custom_emoji_sources("<:wave:123> <a:dance:456> <:wave:123>")
        self.assertEqual(len(items), 2)
        self.assertEqual(items[0]["url"], "https://cdn.discordapp.com/emojis/123.png")
        self.assertEqual(items[1]["content_type"], "image/gif")

    def test_ffmpeg_uses_python_bundled_binary_when_system_binary_is_missing(self):
        with patch("aira.media.shutil.which", return_value=None), \
             patch("imageio_ffmpeg.get_ffmpeg_exe", return_value="/venv/bin/ffmpeg"):
            self.assertEqual(_ffmpeg_binary(), "/venv/bin/ffmpeg")

    def test_image_resize_and_gif_metadata(self):
        image = Image.new("RGB", (2000, 1000), "red")
        buffer = io.BytesIO()
        image.save(buffer, format="PNG")
        resized, mime = _image_for_model(buffer.getvalue(), "image/png")
        with Image.open(io.BytesIO(resized)) as result:
            self.assertLessEqual(max(result.size), 1500)
        self.assertIn(mime, {"image/jpeg", "image/png"})

        frames = [Image.new("RGB", (20, 20), color) for color in ("red", "blue")]
        gif = io.BytesIO()
        frames[0].save(gif, format="GIF", save_all=True, append_images=frames[1:],
                       duration=[300, 400], loop=0)
        self.assertAlmostEqual(_gif_duration(gif.getvalue()), 0.7, delta=0.1)


if __name__ == "__main__":
    unittest.main()
