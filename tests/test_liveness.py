import asyncio
import unittest

from aira.liveness import Liveness


class LivenessTests(unittest.TestCase):
    def test_counters_and_ready_state(self):
        live = Liveness(lambda: {0: True}, lambda: "123", heartbeat_seconds=60)
        live.note("seen")
        live.note("nonBot")
        live.note("queued")
        self.assertEqual(live.snapshot()["queued"], 1)
        state = live.state()
        self.assertTrue(state["ok"])
        self.assertEqual(state["channel"], "123")

    def test_not_ready_if_a_shard_is_not_connected(self):
        live = Liveness(lambda: {0: True, 1: False}, lambda: None)
        self.assertFalse(live.state()["ok"])


if __name__ == "__main__":
    unittest.main()
