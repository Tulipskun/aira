from __future__ import annotations

import io
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from urllib.error import HTTPError

import aira.config as config_module

from aira.discord_auth import (
    InvalidDiscordToken,
    get_discord_token,
    save_token,
    validate_discord_token,
    get_discord_owner_id,
)


class DiscordAuthTests(unittest.TestCase):
    def test_saves_token_with_private_permissions(self):
        with tempfile.TemporaryDirectory() as directory:
            token_path = Path(directory) / ".aira" / "discord.token"
            save_token("example-token", token_path)
            self.assertEqual(token_path.read_text("utf-8").strip(), "example-token")
            self.assertEqual(token_path.stat().st_mode & 0o777, 0o600)
            self.assertEqual(token_path.parent.stat().st_mode & 0o777, 0o700)

    def test_saved_token_is_reused_without_prompting(self):
        with tempfile.TemporaryDirectory() as directory:
            token_path = Path(directory) / ".aira" / "discord.token"
            save_token("saved-token", token_path)
            result = get_discord_token(
                token_path=token_path,
                environ={},
                prompt=lambda _message: self.fail("prompt should not be called"),
                validator=lambda token: self.assertEqual(token, "saved-token"),
                notify=lambda _message: None,
            )
            self.assertEqual(result, "saved-token")

    def test_invalid_prompt_is_rejected_then_valid_token_is_saved(self):
        with tempfile.TemporaryDirectory() as directory:
            token_path = Path(directory) / ".aira" / "discord.token"
            answers = iter(["bad-token", "good-token"])
            validated = []

            def validator(token):
                validated.append(token)
                if token == "bad-token":
                    raise InvalidDiscordToken

            result = get_discord_token(
                token_path=token_path,
                environ={},
                prompt=lambda _message: next(answers),
                validator=validator,
                notify=lambda _message: None,
            )
            self.assertEqual(result, "good-token")
            self.assertEqual(validated, ["bad-token", "good-token"])
            self.assertEqual(token_path.read_text("utf-8").strip(), "good-token")

    def test_legacy_environment_token_is_migrated(self):
        with tempfile.TemporaryDirectory() as directory:
            token_path = Path(directory) / ".aira" / "discord.token"
            result = get_discord_token(
                token_path=token_path,
                environ={"DISCORD": "legacy-token"},
                prompt=lambda _message: self.fail("legacy token should be migrated"),
                validator=lambda token: self.assertEqual(token, "legacy-token"),
                notify=lambda _message: None,
            )
            self.assertEqual(result, "legacy-token")
            self.assertEqual(token_path.read_text("utf-8").strip(), "legacy-token")


    def test_config_prefers_saved_token_to_legacy_environment(self):
        with tempfile.TemporaryDirectory() as directory:
            runtime_dir = Path(directory) / ".aira"
            runtime_dir.mkdir()
            (runtime_dir / "discord.token").write_text("saved-token\\n", encoding="utf-8")
            with patch.object(config_module, "ROOT", Path(directory)), patch.dict(os.environ, {"DISCORD": "old-env-token"}):
                config = config_module.Config()
            self.assertEqual(config.discord_token, "saved-token")

    def test_config_falls_back_to_legacy_environment_without_saved_file(self):
        with tempfile.TemporaryDirectory() as directory:
            with patch.object(config_module, "ROOT", Path(directory)), patch.dict(os.environ, {"DISCORD": "legacy-token"}):
                config = config_module.Config()
            self.assertEqual(config.discord_token, "legacy-token")


    def test_token_with_embedded_whitespace_is_rejected_before_request(self):
        with self.assertRaises(InvalidDiscordToken):
            validate_discord_token("bad token", opener=lambda *_args, **_kwargs: self.fail("request should not run"))

    def test_discord_403_is_not_misreported_as_invalid_token(self):
        def opener(request, timeout):
            raise HTTPError(request.full_url, 403, "Forbidden", {}, None)

        with self.assertRaisesRegex(RuntimeError, "HTTP 403"):
            validate_discord_token("valid-looking-token", opener=opener)

    def test_discord_rejects_non_bot_identity(self):
        class FakeResponse(io.BytesIO):
            pass

        def opener(_request, timeout):
            self.assertEqual(timeout, 15)
            return FakeResponse(json.dumps({"id": "123", "bot": False}).encode())

        with self.assertRaises(InvalidDiscordToken):
            validate_discord_token("not-a-bot-token", opener=opener)

    def test_discord_401_is_invalid_token(self):
        def opener(request, timeout):
            self.assertIn("Authorization", request.headers)
            raise HTTPError(request.full_url, 401, "Unauthorized", {}, None)

        with self.assertRaises(InvalidDiscordToken):
            validate_discord_token("invalid", opener=opener)


    def test_owner_id_is_prompted_once_and_saved_privately(self):
        with tempfile.TemporaryDirectory() as directory:
            owner_path = Path(directory) / ".aira" / "owner.id"
            result = get_discord_owner_id(
                owner_path=owner_path, environ={},
                prompt=lambda _message: "123456789012345678",
                notify=lambda _message: None,
            )
            self.assertEqual(result, "123456789012345678")
            self.assertEqual(owner_path.read_text("utf-8").strip(), result)
            self.assertEqual(owner_path.stat().st_mode & 0o777, 0o600)

    def test_saved_owner_id_is_reused_without_prompt(self):
        with tempfile.TemporaryDirectory() as directory:
            owner_path = Path(directory) / ".aira" / "owner.id"
            owner_path.parent.mkdir()
            owner_path.write_text("123456789012345678\\n", encoding="utf-8")
            result = get_discord_owner_id(
                owner_path=owner_path, environ={},
                prompt=lambda _message: self.fail("prompt should not be called"),
                notify=lambda _message: None,
            )
            self.assertEqual(result, "123456789012345678")

    def test_invalid_owner_id_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(RuntimeError, "valid Discord user ID"):
                get_discord_owner_id(
                    owner_path=Path(directory) / ".aira" / "owner.id",
                    environ={}, prompt=lambda _message: "not-an-id",
                    notify=lambda _message: None,
                )


if __name__ == "__main__":
    unittest.main()
