import random
import unittest
from datetime import datetime

from aira import idle


class IdlePacingTests(unittest.TestCase):
    def test_a_quiet_room_waits_between_fifteen_and_forty_five_minutes(self):
        now = datetime(2026, 2, 1, 15, 0)
        gaps = [idle.idle_target_minutes(now, random.Random(seed)) for seed in range(40)]
        self.assertGreaterEqual(min(gaps), idle.FRESH_MIN_MINUTES)
        self.assertLessEqual(max(gaps), idle.FRESH_MAX_MINUTES)
        self.assertGreater(len(set(gaps)), 10)

    def test_a_hanging_matter_is_not_given_a_wait_at_all(self):
        # Resuming is decided by the room, so there is no resume window left to sample.
        self.assertFalse([name for name in dir(idle) if name.startswith("RESUME")])

    def test_the_day_has_natural_beats(self):
        self.assertEqual(idle.day_anchor(datetime(2026, 2, 1, 8, 0)), "morning")
        self.assertEqual(idle.day_anchor(datetime(2026, 2, 1, 12, 30)), "noon")
        self.assertEqual(idle.day_anchor(datetime(2026, 2, 1, 19, 0)), "evening")
        self.assertIsNone(idle.day_anchor(datetime(2026, 2, 1, 4, 0)))

    def test_once_the_wait_is_over_the_room_speaks(self):
        # The dice pick the wait, never whether anyone speaks at the end of it.
        for hour in (3, 9, 13, 20, 23):
            now = datetime(2026, 2, 1, hour, 0)
            for seed in range(5):
                wait = idle.idle_target_minutes(now, random.Random(seed))
                self.assertTrue(idle.should_start(now, wait + 0.5, wait))

    def test_the_room_stays_quiet_when_it_has_been_dead_for_hours(self):
        now = datetime(2026, 2, 1, 20, 0)
        self.assertFalse(idle.should_start(now, idle.DEAD_ROOM_MINUTES + 1, 10))

    def test_the_room_keeps_talking_while_the_allowance_pays_for_it(self):
        now = datetime(2026, 2, 1, 20, 0)
        self.assertFalse(hasattr(idle, "MAX_STARTS_PER_HOUR"))
        self.assertTrue(idle.should_start(now, 30, 10))


if __name__ == "__main__":
    unittest.main()
