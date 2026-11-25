from __future__ import annotations

import argparse
import asyncio
import copy
import logging
import os
import sys

import aiohttp
from dotenv import load_dotenv

load_dotenv()

from .config import config

API = "https://discord.com/api/v10"
log = logging.getLogger("aira.register_commands")

ISLA_COMMAND = {
    "name": "isla",
    "description": "คำสั่ง isla",
    "type": 1,
    "options": [
        {
            "type": 1,
            "name": "join-group",
            "description": "เข้าร่วม session รวมของแชแนลนี้ (แชร์ context กับสมาชิกคนอื่นที่เข้าร่วม)",
        },
        {
            "type": 1,
            "name": "leave-group",
            "description": "ออกจาก session รวม กลับไปใช้ session ส่วนตัว",
        },
        {
            "type": 1,
            "name": "status",
            "description": "ดูสถานะ session ปัจจุบัน และรายชื่อคนที่เข้าร่วมในแชแนลนี้",
        },
        {
            "type": 1,
            "name": "leaderboard",
            "description": "ดู 10 อันดับผู้ใช้ที่มี XP สูงสุด",
        },
    ],
}


def _writable_command(command: dict) -> dict:
    readonly = {"id", "application_id", "guild_id", "version"}
    return {key: value for key, value in command.items() if key not in readonly}


def merge_commands(existing: list[dict]) -> list[dict]:
    preserved = [
        _writable_command(command) for command in existing
        if command.get("name") != ISLA_COMMAND["name"]
    ]
    return [*preserved, copy.deepcopy(ISLA_COMMAND)]


async def register_commands(token: str, dry_run: bool = False) -> dict:
    timeout = aiohttp.ClientTimeout(total=30, connect=10)
    headers = {"Authorization": f"Bot {token}", "Content-Type": "application/json"}
    async with aiohttp.ClientSession(timeout=timeout, headers=headers) as session:
        async with session.get(f"{API}/oauth2/applications/@me") as response:
            if response.status != 200:
                raise RuntimeError(f"Could not read Discord application ({response.status}): {(await response.text())[:500]}")
            application = await response.json()
        application_id = str(application["id"])
        endpoint = f"{API}/applications/{application_id}/commands"
        async with session.get(endpoint) as response:
            if response.status != 200:
                raise RuntimeError(f"Could not read existing global commands ({response.status}): {(await response.text())[:500]}")
            existing = await response.json()
        payload = merge_commands(existing)
        preserved_count = len(payload) - 1
        if dry_run:
            return {
                "application_id": application_id,
                "existing_count": len(existing),
                "preserved_count": preserved_count,
                "payload": payload,
                "dry_run": True,
            }
        async with session.put(endpoint, json=payload) as response:
            if response.status not in (200, 201):
                raise RuntimeError(f"Could not update global commands ({response.status}): {(await response.text())[:1000]}")
            registered = await response.json()
        return {
            "application_id": application_id,
            "registered_count": len(registered),
            "preserved_count": preserved_count,
            "dry_run": False,
        }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Register Aira's /isla command group without deleting other app commands.")
    parser.add_argument("--dry-run", action="store_true", help="show the API request but do not update commands")
    args = parser.parse_args(argv)
    token = config.discord_token
    if not token:
        parser.error("DISCORD environment variable is required")
    try:
        result = asyncio.run(register_commands(token, args.dry_run))
        print(result)
        return 0
    except Exception as exc:
        print(f"[AIRA] Command registration failed: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
