import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from aira import debug_dump
from aira.config import config


class DebugDumpTests(unittest.TestCase):
    def test_dump_is_bounded_private_and_redacted(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "gemini.json"
            with patch.object(config, "debug_payload", True), patch.object(config, "debug_payload_file", path):
                for index in range(9):
                    debug_dump.debug_dump({
                        "event": "request", "attempt": index,
                        "payload": {
                            "api_key": "should-not-appear",
                            "text": "AIza" + ("A" * 32),
                            "signature": "a-signature-that-is-long",
                        },
                    })
            records = debug_dump.read_debug_dump(path)
            self.assertEqual(len(records), 6)
            self.assertEqual(records[-1]["payload"]["api_key"], "[redacted]")
            self.assertNotIn("should-not-appear", path.read_text("utf-8"))
            self.assertNotIn("AIza", path.read_text("utf-8"))
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)

    def test_disabled_dump_does_not_create_files(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "disabled.json"
            with patch.object(config, "debug_payload", False), patch.object(config, "debug_payload_file", path):
                debug_dump.debug_dump({"event": "request"})
            self.assertFalse(path.exists())


if __name__ == "__main__":
    unittest.main()
