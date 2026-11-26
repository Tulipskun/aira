"""When does the cast speak up on its own?

Humans do not restart a quiet conversation on a fixed clock: the gap varies,
nobody speaks during the night, and even when the room has been quiet for a
while someone only says something if they actually have something to say. This
module holds that pacing so the bot never sounds like a scheduled job.
"""
from __future__ import annotations

import random
from datetime import datetime

# A thread left hanging is finished straight away; a room with nothing pending
# waits, and may then open a new topic on a time-of-day beat or by chance.
RESUME_MIN_MINUTES = 0.5
RESUME_MAX_MINUTES = 2.0
FRESH_MIN_MINUTES = 30.0
FRESH_MAX_MINUTES = 90.0
ANCHOR_MIN_QUIET_MINUTES = 12.0
# Beats in the day when people naturally bring something up.
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


def start_probability(now: datetime, open_thread: bool = False) -> float:
    """How likely someone picks the room up once its silence target is reached."""
    if open_thread:
        # An unfinished topic gets finished; only deep night holds it back.
        return 0.5 if QUIET_START_HOUR <= now.hour < QUIET_END_HOUR else 1.0
    if now.hour < QUIET_START_HOUR:
        return 0.2
    if QUIET_START_HOUR <= now.hour < QUIET_END_HOUR:
        return 0.2
    if now.hour >= 23:
        return 0.3
    return 0.5


def should_start(now: datetime, quiet_minutes: float, target_minutes: float,
                 starts_last_hour: int, open_thread: bool = False,
                 rng: random.Random | None = None) -> bool:
    """Decide whether this is a natural moment to start a conversation."""
    if quiet_minutes < target_minutes:
        return False
    if quiet_minutes > DEAD_ROOM_MINUTES:
        return False
    if starts_last_hour >= MAX_STARTS_PER_HOUR:
        return False
    return (rng or random).random() < start_probability(now, open_thread)
