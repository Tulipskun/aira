import asyncio
import json
import pathlib

import aiohttp

TOKEN = pathlib.Path("/root/aira/.aira/discord.token").read_text().strip()
CHANNEL_ID = str(json.loads(
    pathlib.Path("/root/aira/.aira/discord-config.json").read_text())["responseChannelId"])
API = "https://discord.com/api/v10"
BOT_HEADERS = {"Authorization": f"Bot {TOKEN}"}


async def main():
    async with aiohttp.ClientSession() as session:
        async with session.get(f"{API}/channels/{CHANNEL_ID}/messages?limit=15",
                               headers=BOT_HEADERS) as response:
            messages = await response.json()
        target = next((item for item in messages
                       if not item.get("webhook_id") and not item["author"].get("bot")), None)
        if target is None:
            print("no user message to reference")
            return
        print("referencing:", target["id"], "|", target["author"]["username"], "|",
              (target.get("content") or "")[:40])

        async with session.get(f"{API}/channels/{CHANNEL_ID}/webhooks", headers=BOT_HEADERS) as response:
            hooks = await response.json()
        hook = next((item for item in hooks if item.get("name", "").startswith("Aira Character")), None)
        print("webhook:", hook["name"], hook["id"], "application_id:", hook.get("application_id"))

        payload = {
            "content": "ทดสอบระบบ: ข้อความนี้พยายาม reply ผ่าน webhook",
            "username": "Origami Tobiichi",
            "message_reference": {"message_id": target["id"], "fail_if_not_exists": False},
            "allowed_mentions": {"parse": []},
        }
        url = f"{API}/webhooks/{hook['id']}/{hook['token']}?wait=true"
        async with session.post(url, json=payload) as response:
            status = response.status
            body = await response.json() if response.content_type == "application/json" else await response.text()
        print("status:", status)
        if isinstance(body, dict):
            print("message id:", body.get("id"), "type:", body.get("type"))
            print("message_reference:", json.dumps(body.get("message_reference"), ensure_ascii=False))
            referenced = body.get("referenced_message")
            print("referenced_message id:", (referenced or {}).get("id"))
            if status < 400 and body.get("id"):
                async with session.delete(f"{API}/channels/{CHANNEL_ID}/messages/{body['id']}",
                                          headers=BOT_HEADERS) as deleted:
                    print("cleanup delete status:", deleted.status)
        else:
            print("body:", str(body)[:300])


asyncio.run(main())
