import random
import unittest
from datetime import datetime

from aira import idle


class IdlePacingTests(unittest.TestCase):
    def test_a_thread_left_open_is_finished_straight_away(self):
        now = datetime(2026, 2, 1, 15, 0)
        gaps = [idle.idle_target_minutes(now, True, random.Random(seed)) for seed in range(20)]
        self.assertGreater(len(set(gaps)), 5)
        for gap in gaps:
            self.assertLessEqual(gap, idle.RESUME_MAX_MINUTES)

    def test_a_room_with_nothing_pending_rests_much_longer(self):
        now = datetime(2026, 2, 1, 15, 0)
        resume = idle.idle_target_minutes(now, True, random.Random(4))
        fresh = idle.idle_target_minutes(now, False, random.Random(4))
        self.assertGreater(fresh, resume * 10)
        self.assertGreaterEqual(fresh, idle.FRESH_MIN_MINUTES)

    def test_night_waits_much_longer_than_afternoon(self):
        night = datetime(2026, 2, 1, 4, 0)
        afternoon = datetime(2026, 2, 1, 15, 0)
        self.assertGreater(idle.idle_target_minutes(night, True, random.Random(3)),
                           idle.idle_target_minutes(afternoon, True, random.Random(3)) * 2)

    def test_the_day_has_natural_beats(self):
        self.assertEqual(idle.day_anchor(datetime(2026, 2, 1, 8, 0)), "morning")
        self.assertEqual(idle.day_anchor(datetime(2026, 2, 1, 12, 30)), "noon")
        self.assertEqual(idle.day_anchor(datetime(2026, 2, 1, 19, 0)), "evening")
        self.assertIsNone(idle.day_anchor(datetime(2026, 2, 1, 4, 0)))

    def test_an_unfinished_topic_is_far_more_likely_to_be_resumed(self):
        evening = datetime(2026, 2, 1, 20, 0)
        self.assertGreater(idle.start_probability(evening, True),
                           idle.start_probability(evening, False) * 2)
        rolls = [idle.should_start(evening, 30, 10, 0, True, random.Random(seed))
                 for seed in range(20)]
        self.assertGreater(sum(rolls), sum(
            idle.should_start(evening, 30, 10, 0, False, random.Random(seed))
            for seed in range(20)))

    def test_a_quiet_room_only_restarts_after_its_gap(self):
        now = datetime(2026, 2, 1, 20, 0)
        self.assertFalse(idle.should_start(now, 2, 10, 0, True, random.Random(1)))
        self.assertTrue(idle.should_start(now, 11, 10, 0, True, random.Random(1)))

    def test_the_room_stays_quiet_when_it_has_been_dead_for_hours(self):
        now = datetime(2026, 2, 1, 20, 0)
        self.assertFalse(idle.should_start(now, idle.DEAD_ROOM_MINUTES + 1, 10, 0, True,
                                           random.Random(1)))

    def test_an_hourly_cap_stops_the_cast_talking_to_itself(self):
        now = datetime(2026, 2, 1, 20, 0)
        self.assertFalse(idle.should_start(now, 30, 10, idle.MAX_STARTS_PER_HOUR, True,
                                           random.Random(1)))


if __name__ == "__main__":
    unittest.main()
