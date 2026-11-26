"""When does the cast speak up on its own?

Humans do not restart a quiet conversation on a fixed clock: the gap varies,
nobody speaks during the night, and even when the room has been quiet for a
while someone only says something if they actually have something to say. This
module holds that pacing so the bot never sounds like a scheduled job.
"""
from __future__ import annotations

import random
from datetime import datetime

IDLE_MIN_MINUTES = 3.0
IDLE_MAX_MINUTES = 14.0
QUIET_START_HOUR = 2
QUIET_END_HOUR = 9
QUIET_MULTIPLIER = 3.0
MAX_STARTS_PER_HOUR = 4
DEAD_ROOM_MINUTES = 12 * 60


def idle_target_minutes(now: datetime, rng: random.Random | None = None) -> float:
    """Pick how long this silence should last before anyone considers talking."""
    generator = rng or random
    target = generator.uniform(IDLE_MIN_MINUTES, IDLE_MAX_MINUTES)
    if QUIET_START_HOUR <= now.hour < QUIET_END_HOUR:
        target *= QUIET_MULTIPLIER
    return target


def start_probability(now: datetime) -> float:
    """How likely someone wants to speak once the silence target is reached."""
    if now.hour < QUIET_START_HOUR:
        return 0.35
    if QUIET_START_HOUR <= now.hour < QUIET_END_HOUR:
        return 0.2
    if now.hour >= 23:
        return 0.5
    return 0.85


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
