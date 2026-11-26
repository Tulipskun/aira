"""When does the cast speak up on its own?

Humans do not restart a quiet conversation on a fixed clock: the gap varies,
nobody speaks during the night, and even when the room has been quiet for a
while someone only says something if they actually have something to say. This
module holds that pacing, and nothing else: it labels the moment and decides
when an opening may happen. What the characters say is never scripted here.
"""
from __future__ import annotations

import random
from datetime import datetime

# A thread left hanging is answered at once, without any wait; a room with
# nothing pending waits this long before someone opens a new topic.
FRESH_MIN_MINUTES = 15.0
FRESH_MAX_MINUTES = 45.0
ANCHOR_MIN_QUIET_MINUTES = 12.0
QUIET_START_HOUR = 2
QUIET_END_HOUR = 9
QUIET_MULTIPLIER = 3.0
MAX_STARTS_PER_HOUR = 4
DEAD_ROOM_MINUTES = 12 * 60
# Moments of the day when people naturally greet each other.
DAY_ANCHORS = (("morning", 7, 10), ("noon", 11, 14), ("evening", 17, 21))


def part_of_day(now: datetime) -> str:
    """The label the model is given; what to say about it is its own decision."""
    if 5 <= now.hour < 12:
        return "morning"
    if 12 <= now.hour < 17:
        return "noon"
    if 17 <= now.hour < 22:
        return "evening"
    return "night"


def day_anchor(now: datetime) -> str | None:
    """Which natural moment of the day this is, if any."""
    for name, start, end in DAY_ANCHORS:
        if start <= now.hour < end:
            return name
    return None


def idle_target_minutes(now: datetime, rng: random.Random | None = None) -> float:
    """How long this silence should last before anyone considers talking."""
    generator = rng or random
    target = generator.uniform(FRESH_MIN_MINUTES, FRESH_MAX_MINUTES)
    if QUIET_START_HOUR <= now.hour < QUIET_END_HOUR:
        target *= QUIET_MULTIPLIER
    return target


def start_probability(now: datetime) -> float:
    """How likely someone picks the room up once its silence target is reached."""
    if now.hour < QUIET_START_HOUR:
        return 0.2
    if QUIET_START_HOUR <= now.hour < QUIET_END_HOUR:
        return 0.2
    if now.hour >= 23:
        return 0.3
    return 0.5


def should_start(now: datetime, quiet_minutes: float, target_minutes: float,
                 starts_last_hour: int, rng: random.Random | None = None) -> bool:
    """Decide whether this is a natural moment to start a conversation."""
    if quiet_minutes < target_minutes:
        return False
    if quiet_minutes > DEAD_ROOM_MINUTES:
        return False
    if starts_last_hour >= MAX_STARTS_PER_HOUR:
        return False
    return (rng or random).random() < start_probability(now)
