from __future__ import annotations

import asyncio
import json
import logging
import math
import os
import time
from pathlib import Path
from collections import deque
from dataclasses import dataclass

log = logging.getLogger("aira.token_budget")


def estimate_tokens(text: str) -> int:
    """Conservative local estimate; reconciled against Live API usage metadata."""
    value = str(text or "")
    ascii_chars = sum(1 for char in value if ord(char) < 128)
    other_chars = len(value) - ascii_chars
    # Live API promptTokenCount measurements showed the raw character heuristic
    # overestimated mixed Thai/English prompts by about 65%; retain a 20%
    # conservative margin while avoiding unnecessary TPM queueing.
    raw_estimate = ascii_chars / 3.0 + other_chars * 1.15
    return max(1, math.ceil(raw_estimate * 0.80))


def estimate_live_request_tokens(system_instruction: str, parts: list, output_reserve: int = 1800) -> int:
    total = estimate_tokens(system_instruction)
    for part in parts:
        text = getattr(part, "text", None)
        if text:
            total += estimate_tokens(text)
        if getattr(part, "inline_data", None) is not None:
            # Image tokenization varies by resolution; reserve conservatively.
            total += 2200
    return total + max(0, int(output_reserve))


@dataclass
class Reservation:
    created_at: float
    tokens: int


class SlidingWindowTokenBudget:
    """One shared project-level rolling budget for Live text generations."""

    def __init__(self, limit: int = 65_000, window_seconds: float = 60.0,
                 safety_ratio: float = 0.85, state_path: Path | None = None,
                 default_request_tokens: int = 12_000):
        self.limit = max(1, int(limit))
        self.window_seconds = max(1.0, float(window_seconds))
        self.capacity = max(1, int(self.limit * min(1.0, max(0.1, safety_ratio))))
        # Used only until the ledger has measured at least one real request.
        self.default_request_tokens = max(1, int(default_request_tokens))
        self.state_path = Path(state_path) if state_path else None
        self._events: deque[Reservation] = deque()
        self._lock = asyncio.Lock()
        self._load_state()

    def _load_state(self) -> None:
        if self.state_path is None:
            return
        if not self.state_path.exists():
            return
        try:
            data = json.loads(self.state_path.read_text("utf-8"))
            now = time.time()
            cutoff = now - self.window_seconds
            items = data.get("events", []) if isinstance(data, dict) else []
            self._events.extend(
                Reservation(float(item["created_at"]), max(0, int(item["tokens"])))
                for item in items
                if isinstance(item, dict)
                and cutoff < float(item.get("created_at", 0)) <= now + 2
                and int(item.get("tokens", 0)) > 0
            )
            log.info("Restored Gemini TPM ledger: events=%s used=%s/%s",
                     len(self._events), self._used(now), self.capacity)
        except (OSError, ValueError, TypeError, KeyError):
            log.warning("Could not restore Gemini TPM ledger; starting with an empty local window")

    def _save_state(self) -> None:
        if self.state_path is None:
            return
        try:
            self.state_path.parent.mkdir(parents=True, exist_ok=True)
            tmp = self.state_path.with_suffix(self.state_path.suffix + ".tmp")
            payload = {"events": [
                {"created_at": item.created_at, "tokens": item.tokens}
                for item in self._events if item.tokens > 0
            ]}
            tmp.write_text(json.dumps(payload, separators=(",", ":")) + "\n", encoding="utf-8")
            os.chmod(tmp, 0o600)
            tmp.replace(self.state_path)
            os.chmod(self.state_path, 0o600)
        except OSError:
            log.exception("Could not persist Gemini TPM ledger")

    def _purge(self, now: float) -> None:
        cutoff = now - self.window_seconds
        while self._events and (self._events[0].created_at <= cutoff or self._events[0].tokens <= 0):
            self._events.popleft()

    def _used(self, now: float) -> int:
        self._purge(now)
        return sum(item.tokens for item in self._events)

    def available_tokens(self) -> int:
        return max(0, self.capacity - self._used(time.time()))

    def average_request_tokens(self) -> int:
        """Mean input tokens of the requests measured inside the current window."""
        self._purge(time.time())
        measured = [event.tokens for event in self._events if event.tokens > 0]
        if not measured:
            return self.default_request_tokens
        return max(1, int(sum(measured) / len(measured)))

    def requests_per_window(self) -> int:
        """How many requests the TPM allowance pays for in one window."""
        return max(1, self.capacity // self.average_request_tokens())

    def remaining_turns(self) -> int:
        """Completed requests the remaining window budget can still pay for."""
        return self.available_tokens() // self.average_request_tokens()

    def target_request_tokens(self) -> int:
        """Request size we aim for so the window always funds several turns."""
        return max(1, int(self.capacity * PER_REQUEST_RATIO))

    def turn_interval_seconds(self) -> float:
        """Minimum spacing between automated turns implied by the allowance."""
        return self.window_seconds / self.requests_per_window()

    def snapshot(self) -> dict:
        now = time.time()
        used = self._used(now)
        return {
            "windowSeconds": self.window_seconds,
            "configuredLimit": self.limit,
            "limitSource": "aira_local_guard_not_google_quota",
            "providerLimit": None,
            "safeCapacity": self.capacity,
            "inputTokensUsed": used,
            "inputTokensRemaining": max(0, self.capacity - used),
            "events": len(self._events),
            "averageRequestTokens": self.average_request_tokens(),
            "requestsPerWindow": self.requests_per_window(),
            "remainingTurns": self.remaining_turns(),
        }

    async def reserve(self, tokens: int, label: str = "") -> Reservation:
        amount = max(1, int(tokens))
        if amount > self.capacity:
            raise ValueError(
                f"Single Gemini request estimate ({amount}) exceeds the safe TPM budget ({self.capacity})"
            )
        waited = 0.0
        while True:
            async with self._lock:
                now = time.time()
                used = self._used(now)
                if used + amount <= self.capacity:
                    reservation = Reservation(now, amount)
                    self._events.append(reservation)
                    self._save_state()
                    if waited >= 0.1:
                        log.warning("TPM queue released: stage=%s waited_ms=%.0f used=%s/%s",
                                    label or "unknown", waited * 1000, used, self.capacity)
                    return reservation
                oldest = self._events[0] if self._events else None
                delay = max(0.05, (oldest.created_at + self.window_seconds - now + 0.02)
                            if oldest else 0.05)
                if waited == 0:
                    log.warning("TPM budget full: stage=%s queued_tokens=%s used=%s/%s",
                                label or "unknown", amount, used, self.capacity)
            await asyncio.sleep(delay)
            waited += delay

    async def settle(self, reservation: Reservation, actual_tokens: int | None = None) -> None:
        if actual_tokens is None:
            return
        async with self._lock:
            reservation.tokens = max(0, int(actual_tokens))
            if reservation.tokens == 0:
                try:
                    self._events.remove(reservation)
                except ValueError:
                    pass
            self._save_state()

    def history_budget(self, reserve_tokens: int = 6_000) -> int:
        """History size that still leaves the prompt inside one turn's share."""
        usable = max(0, self.target_request_tokens() - max(0, int(reserve_tokens)))
        return max(0, min(usable, self.available_tokens()))


# One turn may spend at most this share of the window, so a full minute always
# funds several exchanges instead of one giant request eating the allowance.
PER_REQUEST_RATIO = 0.25

_LIMIT = int(os.environ.get("AIRA_GEMINI_TPM_LIMIT", "65000"))
live_token_budget = SlidingWindowTokenBudget(
    _LIMIT, window_seconds=60, safety_ratio=0.85,
    state_path=Path(__file__).resolve().parent.parent / ".aira" / "gemini-tpm.json",
)


def history_budget_tokens(kind: str = "reply") -> int:
    """Same ledger, same arithmetic: the prompt fits one turn's share of the window."""
    if kind == "selector":
        return live_token_budget.history_budget(reserve_tokens=8_000)
    if kind == "conversation":
        return live_token_budget.history_budget(reserve_tokens=9_000)
    return live_token_budget.history_budget(reserve_tokens=6_000)


def usage_metrics(metadata) -> dict[str, int | None]:
    """Normalize Gemini usage metadata without mixing input and output tokens."""
    if metadata is None:
        return {name: None for name in (
            "input", "output", "thinking", "tool_input", "cached", "total"
        )}

    def number(name: str) -> int | None:
        value = getattr(metadata, name, None)
        return int(value) if isinstance(value, (int, float)) and value >= 0 else None

    return {
        "input": number("prompt_token_count"),
        "output": number("candidates_token_count"),
        "thinking": number("thoughts_token_count"),
        "tool_input": number("tool_use_prompt_token_count"),
        "cached": number("cached_content_token_count"),
        "total": number("total_token_count"),
    }


def usage_tpm_tokens(metadata) -> int | None:
    """Gemini TPM is based on input tokens, not generated/thinking tokens.

    cached tokens are already included in prompt_token_count and must not be
    added a second time. Tool-result prompt tokens are a separate input bucket.
    """
    metrics = usage_metrics(metadata)
    input_tokens = metrics["input"]
    tool_tokens = metrics["tool_input"] or 0
    if input_tokens is None and metrics["tool_input"] is None:
        return None
    return max(0, int(input_tokens or 0) + int(tool_tokens))


def usage_total_tokens(metadata) -> int | None:
    metrics = usage_metrics(metadata)
    total = metrics["total"]
    if total is not None and total > 0:
        return total
    values = [metrics[name] or 0 for name in ("input", "output", "thinking", "tool_input")]
    value = sum(values)
    return value or None
