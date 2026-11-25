import asyncio
import unittest

from aira import thought_signatures as signatures


class ThoughtSignatureTests(unittest.TestCase):
    def setUp(self):
        self.pool = list(signatures._pool)
        self.cursor = signatures._cursor
        signatures._pool.clear()
        signatures._cursor = 0
        signatures._dirty = False

    def tearDown(self):
        signatures._pool[:] = self.pool
        signatures._cursor = self.cursor
        signatures._dirty = False

    def test_fake_tool_result_has_signed_call_sequence(self):
        steps = signatures.fake_tool_call_result("search_memory", {"user": "A"}, {"memories": []})
        self.assertEqual([step["type"] for step in steps], ["thought", "function_call", "function_result"])
        self.assertEqual(steps[0]["signature"], signatures.BOOTSTRAP_SIGNATURE)
        self.assertEqual(steps[1]["id"], steps[2]["call_id"])

    def test_signatures_rotate_when_rejected(self):
        signatures.add_thought_signature("signature-one")
        steps = signatures.fake_tool_call_result("search_memory", {}, {})
        old = steps[0]["signature"]
        rotated = signatures.rotate_thought_signatures(steps)
        self.assertIsNotNone(rotated)
        self.assertNotEqual(rotated[0]["signature"], old)
        self.assertNotIn(old, signatures._pool)


if __name__ == "__main__":
    unittest.main()
