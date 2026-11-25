import asyncio
import unittest

from aira.scheduler import MessageScheduler


class SchedulerTests(unittest.IsolatedAsyncioTestCase):
    async def test_debounce_and_flush(self):
        flushed = []
        async def on_flush(messages):
            flushed.append(messages)
        scheduler = MessageScheduler(on_flush, debounce_ms=20, max_wait_ms=50)
        scheduler.push({"session_key": "a", "text": "one"})
        scheduler.push({"session_key": "a", "text": "two"})
        self.assertEqual(scheduler.pending_count(), 1)
        await asyncio.sleep(0.04)
        self.assertEqual(len(flushed), 1)
        self.assertEqual([m["text"] for m in flushed[0]], ["one", "two"])
        await scheduler.close()

    async def test_immediate_flush(self):
        flushed = []
        async def on_flush(messages):
            flushed.append(messages)
        scheduler = MessageScheduler(on_flush, debounce_ms=1000)
        scheduler.push({"session_key": "a", "text": "queued"})
        scheduler.push({"session_key": "a", "text": "now", "immediate": True})
        await asyncio.sleep(0.01)
        self.assertEqual([x["text"] for x in flushed[0]], ["queued", "now"])
        await scheduler.close()


if __name__ == "__main__":
    unittest.main()
