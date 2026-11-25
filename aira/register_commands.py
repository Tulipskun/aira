from __future__ import annotations

import argparse
import asyncio
import sys

import aiohttp

from .config import config

API = "https://discord.com/api/v10"
AIRA_COMMAND = {
    "name": "aira",
    "description": "เปิดแผงควบคุมผู้ดูแล Aira",
    "type": 1,
}


def merge_commands(_existing: list[dict]) -> list[dict]:
    """Aira intentionally exposes exactly one global slash command."""
    return [dict(AIRA_COMMAND)]


async def register_commands(token: str, dry_run: bool = False) -> dict:
    timeout = aiohttp.ClientTimeout(total=30, connect=10)
    headers = {"Authorization": f"Bot {token}", "Content-Type": "application/json"}
    async with aiohttp.ClientSession(timeout=timeout, headers=headers) as session:
        async with session.get(f"{API}/oauth2/applications/@me") as response:
            if response.status != 200:
                raise RuntimeError(f"Could not read Discord application ({response.status}): {(await response.text())[:500]}")
            application = await response.json()
        endpoint = f"{API}/applications/{application['id']}/commands"
        async with session.get(endpoint) as response:
            if response.status != 200:
                raise RuntimeError(f"Could not read existing global commands ({response.status}): {(await response.text())[:500]}")
            existing = await response.json()
        payload = merge_commands(existing)
        if dry_run:
            return {"application_id": str(application["id"]), "existing_count": len(existing),
                    "registered_count": 1, "payload": payload, "dry_run": True}
        async with session.put(endpoint, json=payload) as response:
            if response.status not in (200, 201):
                raise RuntimeError(f"Could not replace global commands ({response.status}): {(await response.text())[:1000]}")
            registered = await response.json()
        return {"application_id": str(application["id"]), "registered_count": len(registered),
                "removed_count": max(0, len(existing) - 1), "dry_run": False}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Register only Aira's /aira admin command.")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args(argv)
    if not config.discord_token:
        parser.error("Discord token is required")
    try:
        print(asyncio.run(register_commands(config.discord_token, args.dry_run)))
        return 0
    except Exception as exc:
        print(f"[AIRA] Command registration failed: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
