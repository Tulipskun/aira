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
from aira.discord_auth import InvalidDiscordToken, get_discord_token, save_token, validate_discord_token, get_discord_owner_id

class DiscordAuthTests(unittest.TestCase):
    def test_saves_token_with_private_permissions(self):
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/".aira"/"discord.token"
            save_token("example-token",path)
            self.assertEqual(path.read_text("utf-8").strip(),"example-token")
            self.assertEqual(path.stat().st_mode & 0o777,0o600)
            self.assertEqual(path.parent.stat().st_mode & 0o777,0o700)

    def test_saved_token_is_reused_without_prompting(self):
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/".aira"/"discord.token"; save_token("saved-token",path)
            self.assertEqual(get_discord_token(token_path=path,prompt=lambda _:self.fail("prompt"),validator=lambda value:self.assertEqual(value,"saved-token"),notify=lambda _:None),"saved-token")

    def test_invalid_prompt_then_valid_token(self):
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/".aira"/"discord.token"; answers=iter(["bad-token","good-token"]); checked=[]
            def validate(value):
                checked.append(value)
                if value=="bad-token": raise InvalidDiscordToken
            self.assertEqual(get_discord_token(token_path=path,prompt=lambda _:next(answers),validator=validate,notify=lambda _:None),"good-token")
            self.assertEqual(checked,["bad-token","good-token"])

    def test_config_reads_credentials_only_from_private_files(self):
        with tempfile.TemporaryDirectory() as directory:
            runtime=Path(directory)/".aira"; runtime.mkdir()
            (runtime/"discord.token").write_text("saved-token\n",encoding="utf-8")
            (runtime/"owner.id").write_text("123456789012345678\n",encoding="utf-8")
            with patch.object(config_module,"ROOT",Path(directory)): cfg=config_module.Config()
            self.assertEqual(cfg.discord_token,"saved-token")
            self.assertEqual(cfg.owner_id,"123456789012345678")

    def test_token_whitespace_rejected_before_request(self):
        with self.assertRaises(InvalidDiscordToken):
            validate_discord_token("bad token",opener=lambda *_a,**_k:self.fail("request"))

    def test_discord_403_not_invalid_token(self):
        def opener(request,timeout): raise HTTPError(request.full_url,403,"Forbidden",{},None)
        with self.assertRaisesRegex(RuntimeError,"HTTP 403"): validate_discord_token("token",opener=opener)

    def test_discord_rejects_non_bot_identity(self):
        class Response(io.BytesIO): pass
        def opener(_request,timeout):
            self.assertEqual(timeout,15); return Response(json.dumps({"id":"123","bot":False}).encode())
        with self.assertRaises(InvalidDiscordToken): validate_discord_token("token",opener=opener)

    def test_discord_401_is_invalid_token(self):
        def opener(request,timeout):
            self.assertIn("Authorization",request.headers); raise HTTPError(request.full_url,401,"Unauthorized",{},None)
        with self.assertRaises(InvalidDiscordToken): validate_discord_token("invalid",opener=opener)

    def test_owner_id_is_prompted_once_and_saved_privately(self):
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/".aira"/"owner.id"
            result=get_discord_owner_id(owner_path=path,prompt=lambda _:"123456789012345678",notify=lambda _:None)
            self.assertEqual(result,"123456789012345678")
            self.assertEqual(path.stat().st_mode & 0o777,0o600)

    def test_saved_owner_id_reused_without_prompt(self):
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/".aira"/"owner.id"; path.parent.mkdir(); path.write_text("123456789012345678\n")
            self.assertEqual(get_discord_owner_id(owner_path=path,prompt=lambda _:self.fail("prompt"),notify=lambda _:None),"123456789012345678")

    def test_invalid_owner_id_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(RuntimeError,"valid Discord user ID"):
                get_discord_owner_id(owner_path=Path(directory)/".aira"/"owner.id",prompt=lambda _:"not-an-id",notify=lambda _:None)

if __name__=="__main__": unittest.main()
