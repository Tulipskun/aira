from __future__ import annotations

import asyncio
import logging
import time
from collections import Counter
from typing import Callable

log = logging.getLogger("aira.liveness")
EVENTS = ("seen", "nonBot", "command", "offChannel", "dropped", "queued")


class Liveness:
    def __init__(self, gateway: Callable[[], dict[int, bool]], channel: Callable[[], str | None],
                 heartbeat_seconds: int = 60, idle_seconds: int = 300):
        self.gateway = gateway
        self.channel = channel
        self.heartbeat_seconds = heartbeat_seconds
        self.idle_seconds = idle_seconds
        self.counts: Counter[str] = Counter({key: 0 for key in EVENTS})
        self.started_at = time.monotonic()
        self.last_event_at: float | None = None
        self.last_idle_report_at: float | None = None
        self._task: asyncio.Task | None = None

    def note(self, event: str) -> None:
        if event not in self.counts:
            raise ValueError(f"Unknown liveness event: {event}")
        self.counts[event] += 1
        self.last_event_at = time.monotonic()

    def snapshot(self) -> dict[str, int]:
        return {key: self.counts[key] for key in EVENTS}

    def idle_ms(self) -> int:
        return int(1000 * (time.monotonic() - (self.last_event_at or self.started_at)))

    def state(self) -> dict:
        shards = self.gateway()
        ready = bool(shards) and all(shards.values())
        return {
            "ok": ready, "gatewayReady": ready, "shards": shards,
            "uptimeMs": int(1000 * (time.monotonic() - self.started_at)),
            "idleMs": self.idle_ms(), "channel": self.channel(),
            "counters": self.snapshot(), "ts": int(time.time() * 1000),
        }

    async def report(self, reason: str = "startup") -> None:
        try:
            shards = self.gateway()
            ready_count = sum(bool(x) for x in shards.values())
            total = len(shards)
            idle = self.idle_ms()
            if reason == "idle":
                duration = f"{idle // 3_600_000}h{(idle // 60_000) % 60:02d}m" if idle >= 3_600_000 else f"{idle // 60_000}m" if idle >= 60_000 else f"{idle // 1000}s"
                label = f"silent {duration}"
            else:
                label = "startup"
            values = self.snapshot()
            log.info("[LIVENESS] %s, gateway=%s(%s/%s), channel=%s, messages seen=%s (non-bot=%s, queued=%s, off-channel=%s, command=%s, dropped=%s)",
                     label, "ready" if total and ready_count == total else "NOT-READY",
                     ready_count, total, self.channel() or "NOT SET",
                     values["seen"], values["nonBot"], values["queued"],
                     values["offChannel"], values["command"], values["dropped"])
        except Exception:
            log.exception("Liveness report failed")

    async def _loop(self) -> None:
        while True:
            await asyncio.sleep(self.heartbeat_seconds)
            now = time.monotonic()
            if self.idle_ms() >= self.idle_seconds * 1000 and (self.last_idle_report_at is None or now - self.last_idle_report_at >= self.idle_seconds):
                self.last_idle_report_at = now
                await self.report("idle")

    def start(self) -> None:
        if self._task is None or self._task.done():
            asyncio.create_task(self.report("startup"))
            self._task = asyncio.create_task(self._loop())

    async def close(self) -> None:
        if self._task:
            self._task.cancel()
            await asyncio.gather(self._task, return_exceptions=True)
            self._task = None
