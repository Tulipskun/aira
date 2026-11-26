import random
import unittest
from datetime import datetime

from aira import idle


class IdlePacingTests(unittest.TestCase):
    def test_gap_between_turns_is_uneven_and_never_fixed(self):
        morning = datetime(2026, 2, 1, 15, 0)
        gaps = {idle.idle_target_minutes(morning, random.Random(seed)) for seed in range(20)}
        self.assertGreater(len(gaps), 5)
        for gap in gaps:
            self.assertGreaterEqual(gap, idle.IDLE_MIN_MINUTES)
            self.assertLessEqual(gap, idle.IDLE_MAX_MINUTES)

    def test_night_waits_much_longer_than_afternoon(self):
        night = datetime(2026, 2, 1, 4, 0)
        afternoon = datetime(2026, 2, 1, 15, 0)
        self.assertGreater(idle.idle_target_minutes(night, random.Random(3)),
                           idle.idle_target_minutes(afternoon, random.Random(3)) * 2)

    def test_nobody_starts_a_chat_at_four_in_the_morning_easily(self):
        night = datetime(2026, 2, 1, 4, 0)
        evening = datetime(2026, 2, 1, 20, 0)
        self.assertLess(idle.start_probability(night), idle.start_probability(evening) / 2)
        rolls = [idle.should_start(night, 60, 10, 0, random.Random(seed)) for seed in range(40)]
        self.assertLess(sum(rolls), 30)

    def test_a_quiet_room_only_restarts_after_its_gap(self):
        now = datetime(2026, 2, 1, 20, 0)
        self.assertFalse(idle.should_start(now, 2, 10, 0, random.Random(1)))
        self.assertTrue(idle.should_start(now, 11, 10, 0, random.Random(1)))

    def test_the_room_stays_quiet_when_it_has_been_dead_for_hours(self):
        now = datetime(2026, 2, 1, 20, 0)
        self.assertFalse(idle.should_start(now, idle.DEAD_ROOM_MINUTES + 1, 10, 0, random.Random(1)))

    def test_an_hourly_cap_stops_the_cast_talking_to_itself(self):
        now = datetime(2026, 2, 1, 20, 0)
        self.assertFalse(idle.should_start(now, 30, 10, idle.MAX_STARTS_PER_HOUR, random.Random(1)))


if __name__ == "__main__":
    unittest.main()
