from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass, field
from typing import Awaitable, Callable


@dataclass
class Pending:
    messages: list[dict] = field(default_factory=list)
    first_at: float = 0.0
    task: asyncio.Task | None = None


class MessageScheduler:
    def __init__(self, on_flush: Callable[[list[dict]], Awaitable[None]], debounce_ms: int = 5000, max_wait_ms: int = 12000):
        self.on_flush = on_flush
        self.debounce = debounce_ms / 1000
        self.max_wait = max_wait_ms / 1000
        self.pending: dict[str, Pending] = {}
        self._flush_tasks: set[asyncio.Task] = set()
        self.closed = False

    def _schedule_flush(self, messages: list[dict]) -> None:
        task = asyncio.create_task(self._flush(messages))
        self._flush_tasks.add(task)
        task.add_done_callback(self._flush_tasks.discard)

    def push(self, message: dict) -> None:
        if self.closed:
            return
        key = message["session_key"]
        current = self.pending.get(key)
        if message.get("immediate"):
            if current:
                if current.task:
                    current.task.cancel()
                self.pending.pop(key, None)
                self._schedule_flush([*current.messages, message])
            else:
                self._schedule_flush([message])
            return
        now = time.monotonic()
        if current is None:
            current = Pending(first_at=now)
            self.pending[key] = current
        current.messages.append(message)
        if current.task:
            current.task.cancel()
        delay = max(0.0, min(self.debounce, self.max_wait - (now - current.first_at)))
        current.task = asyncio.create_task(self._delayed_flush(key, delay))

    async def _delayed_flush(self, key: str, delay: float) -> None:
        try:
            await asyncio.sleep(delay)
            self.flush(key)
        except asyncio.CancelledError:
            return

    def flush(self, key: str) -> None:
        current = self.pending.pop(key, None)
        if current is None:
            return
        if current.task and current.task is not asyncio.current_task():
            current.task.cancel()
        self._schedule_flush(current.messages)

    async def _flush(self, messages: list[dict]) -> None:
        try:
            await self.on_flush(messages)
        except Exception:
            import logging
            logging.getLogger("aira.scheduler").exception("Message flush failed")

    def interrupt_other_sessions(self, session_key: str) -> None:
        for key in list(self.pending):
            if key != session_key:
                self.flush(key)

    def flush_all(self) -> None:
        for key in list(self.pending):
            self.flush(key)

    def has_pending(self) -> bool:
        return bool(self.pending)

    def pending_count(self) -> int:
        return len(self.pending)

    async def close(self) -> None:
        self.closed = True
        self.flush_all()
        tasks = list(self._flush_tasks)
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
