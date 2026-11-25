import unittest

from aira.cli import _filters, parser, session_key


class CliTests(unittest.TestCase):
    def test_session_key_requires_kind_prefix(self):
        self.assertEqual(session_key("user:123"), "user:123")
        self.assertEqual(session_key("group:456"), "group:456")
        with self.assertRaises(Exception):
            session_key("123")

    def test_history_parser(self):
        args = parser().parse_args(["history", "clear", "--session", "user:123", "--limit", "5", "--yes"])
        self.assertEqual(args.target, "history")
        self.assertEqual(args.action, "clear")
        self.assertEqual(args.session, "user:123")
        self.assertTrue(args.yes)

    def test_memory_delete_keeps_string_ids(self):
        args = parser().parse_args(["memory", "clear", "--id", "episode-abcdef01", "--yes"])
        self.assertEqual(_filters(args)["ids"], ["episode-abcdef01"])

    def test_history_ids_remain_numeric(self):
        args = parser().parse_args(["history", "clear", "--id", "42", "--yes"])
        self.assertEqual(_filters(args)["ids"], [42])

    def test_memory_search_parser(self):
        args = parser().parse_args(["memory", "search", "กาแฟ", "--session", "group:4"])
        self.assertEqual(args.query, "กาแฟ")
        self.assertEqual(args.session, "group:4")


if __name__ == "__main__":
    unittest.main()
