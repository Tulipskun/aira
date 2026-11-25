from __future__ import annotations

import asyncio
import logging
import socket
import time
from urllib.parse import urlparse

import aiohttp

from .config import config

log = logging.getLogger("aira.warmup")
DNS_HOSTS = [
    "discord.com",
    "discordapp.com",
    "cdn.discordapp.com",
    "media.discordapp.net",
    "generativelanguage.googleapis.com",
    "googleapis.com",
]
HTTP_URLS = [
    "https://discord.com/api/v10/gateway",
    "https://generativelanguage.googleapis.com/",
]
DNS_BUDGET_SECONDS = 8.0
HTTP_BUDGET_SECONDS = 6.0


async def _resolve(host: str) -> bool:
    loop = asyncio.get_running_loop()
    try:
        await loop.getaddrinfo(host, 443, family=socket.AF_UNSPEC, type=socket.SOCK_STREAM)
        return True
    except (OSError, asyncio.TimeoutError):
        return False


async def warm_network() -> dict:
    started = time.monotonic()
    dns_deadline = started + DNS_BUDGET_SECONDS
    dns_ok: set[str] = set()
    pending = set(DNS_HOSTS)
    while pending and time.monotonic() < dns_deadline:
        batch = list(pending)
        results = await asyncio.gather(
            *[asyncio.wait_for(_resolve(host), timeout=max(0.1, dns_deadline - time.monotonic()))
              for host in batch],
            return_exceptions=True,
        )
        for host, result in zip(batch, results):
            if result is True:
                dns_ok.add(host)
                pending.remove(host)
        if pending:
            await asyncio.sleep(0.25)

    http_ok: list[str] = []
    http_started = time.monotonic()
    timeout = aiohttp.ClientTimeout(total=HTTP_BUDGET_SECONDS, connect=3)
    try:
        async with aiohttp.ClientSession(timeout=timeout) as session:
            for url in HTTP_URLS:
                if time.monotonic() - http_started >= HTTP_BUDGET_SECONDS:
                    break
                try:
                    async with session.get(url, allow_redirects=False) as response:
                        await response.content.read(128)
                        # Any HTTP response confirms DNS, TCP and TLS are warm; 401/403 is expected.
                        http_ok.append(urlparse(url).hostname or url)
                except (aiohttp.ClientError, asyncio.TimeoutError):
                    continue
    except Exception:
        log.debug("HTTP warm-up could not create session", exc_info=True)

    elapsed = (time.monotonic() - started) * 1000
    result = {
        "dns_ready": sorted(dns_ok),
        "dns_failed": sorted(pending),
        "http_ready": http_ok,
        "elapsed_ms": round(elapsed),
    }
    log.info("Network warm-up finished: DNS %s/%s, HTTPS %s/%s, %sms",
             len(dns_ok), len(DNS_HOSTS), len(http_ok), len(HTTP_URLS), round(elapsed))
    return result
