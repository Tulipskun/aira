import asyncio
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

from aira.token_budget import (
    SlidingWindowTokenBudget, estimate_tokens, usage_metrics, usage_total_tokens, usage_tpm_tokens,
)


class TokenBudgetTests(unittest.IsolatedAsyncioTestCase):
    def test_estimator_handles_thai_and_ascii(self):
        self.assertGreater(estimate_tokens("สวัสดีค่ะ"), 1)
        self.assertGreater(estimate_tokens("a" * 120), 20)

    def test_usage_metadata_prefers_total(self):
        metadata = SimpleNamespace(
            total_token_count=321, prompt_token_count=200, candidates_token_count=121,
        )
        self.assertEqual(usage_total_tokens(metadata), 321)

    def test_tpm_counts_input_not_generated_or_thinking_tokens(self):
        metadata = SimpleNamespace(
            prompt_token_count=240, tool_use_prompt_token_count=15,
            candidates_token_count=90, thoughts_token_count=120,
            total_token_count=465, cached_content_token_count=80,
        )
        self.assertEqual(usage_tpm_tokens(metadata), 255)
        self.assertEqual(usage_metrics(metadata)["cached"], 80)

    def test_cached_tokens_are_not_added_twice_to_prompt_tpm(self):
        metadata = SimpleNamespace(
            prompt_token_count=500, tool_use_prompt_token_count=None,
            cached_content_token_count=300, candidates_token_count=10,
            thoughts_token_count=0, total_token_count=510,
        )
        self.assertEqual(usage_tpm_tokens(metadata), 500)

    async def test_sliding_window_reserves_and_reconciles(self):
        budget = SlidingWindowTokenBudget(limit=100, window_seconds=0.08, safety_ratio=1.0)
        first = await budget.reserve(70, "test")
        self.assertEqual(budget.available_tokens(), 30)
        self.assertEqual(budget.snapshot()["inputTokensUsed"], 70)
        await budget.settle(first, 40)
        self.assertEqual(budget.available_tokens(), 60)
        second = await budget.reserve(55, "test")
        self.assertEqual(budget.available_tokens(), 5)
        await budget.settle(second, 0)
        self.assertEqual(budget.available_tokens(), 60)

    async def test_tpm_ledger_survives_recreation(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "budget.json"
            first = SlidingWindowTokenBudget(
                limit=100, window_seconds=60, safety_ratio=1.0, state_path=path,
            )
            await first.reserve(30, "persist-test")
            second = SlidingWindowTokenBudget(
                limit=100, window_seconds=60, safety_ratio=1.0, state_path=path,
            )
            self.assertEqual(second.available_tokens(), 70)
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)


if __name__ == "__main__":
    unittest.main()
