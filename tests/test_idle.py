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

    def test_an_unfinished_topic_is_far_more_likely_to_be_resumed(self):
        evening = datetime(2026, 2, 1, 20, 0)
        self.assertGreater(idle.start_probability(datetime(2026, 2, 1, 15, 0)),
                           idle.start_probability(datetime(2026, 2, 1, 3, 0)))
        rolls = [idle.should_start(evening, 30, 10, 0, random.Random(seed))
                 for seed in range(20)]
        self.assertGreater(sum(rolls), sum(
            idle.should_start(evening, 30, 10, 0, random.Random(seed))
            for seed in range(20)))

    def test_a_quiet_room_only_restarts_after_its_gap(self):
        now = datetime(2026, 2, 1, 20, 0)
        self.assertFalse(idle.should_start(now, 2, 10, 0, random.Random(1)))
        self.assertTrue(idle.should_start(now, 11, 10, 0))

    def test_the_day_is_only_labelled_never_scripted(self):
        # The code names the part of the day; what to say is the model's decision.
        self.assertEqual(idle.part_of_day(datetime(2026, 2, 1, 8, 0)), "morning")
        self.assertEqual(idle.part_of_day(datetime(2026, 2, 1, 13, 0)), "noon")
        self.assertEqual(idle.part_of_day(datetime(2026, 2, 1, 19, 0)), "evening")
        self.assertEqual(idle.part_of_day(datetime(2026, 2, 1, 2, 0)), "night")
        self.assertFalse(hasattr(idle, "EVENTS_BY_PERIOD"))

    def test_the_room_stays_quiet_when_it_has_been_dead_for_hours(self):
        now = datetime(2026, 2, 1, 20, 0)
        self.assertFalse(idle.should_start(now, idle.DEAD_ROOM_MINUTES + 1, 10, 0,
                                           random.Random(1)))

    def test_an_hourly_cap_stops_the_cast_talking_to_itself(self):
        now = datetime(2026, 2, 1, 20, 0)
        self.assertFalse(idle.should_start(now, 30, 10, idle.MAX_STARTS_PER_HOUR,
                                           random.Random(1)))


if __name__ == "__main__":
    unittest.main()
