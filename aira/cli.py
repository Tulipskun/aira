from __future__ import annotations

import argparse
import asyncio
import sys

from .memory import clear_memories, count_memories, delete_memories, list_memories, search_memories_text
from .store import store


def session_key(value: str) -> str:
    if value.startswith(("user:", "group:")):
        return value
    raise argparse.ArgumentTypeError("session must be user:<id> or group:<channel>")


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(prog="aira-admin", description="Inspect or selectively forget Aira conversation data.")
    targets = root.add_subparsers(dest="target", required=True)
    for target in ("history", "memory"):
        group = targets.add_parser(target)
        commands = group.add_subparsers(dest="action", required=True)
        listing = commands.add_parser("list")
        clearing = commands.add_parser("clear")
        for command in (listing, clearing):
            command.add_argument("--session", type=session_key)
            command.add_argument("--user")
            command.add_argument("--id", action="append", default=[])
            command.add_argument("--limit", type=int, default=20)
            command.add_argument("--quiet", action="store_true")
        clearing.add_argument("--all", action="store_true")
        clearing.add_argument("--yes", action="store_true", help="perform deletion; without this flag clear is a dry-run")
        if target == "history":
            for command in (listing, clearing):
                command.add_argument("--role", choices=("user", "model"))
                command.add_argument("--before")
                command.add_argument("--after")
        else:
            search = commands.add_parser("search")
            search.add_argument("query")
            search.add_argument("--session", type=session_key)
            search.add_argument("--limit", type=int, default=10)
    return root


def _filters(args) -> dict:
    ids = [int(value) for value in args.id] if args.target == "history" else list(args.id)
    return {"session_key": args.session, "user_id": args.user, "ids": ids}


def _validate(args, parser_obj) -> None:
    if args.limit <= 0:
        parser_obj.error("--limit must be positive")
    if args.target == "history":
        for value in args.id:
            try:
                if int(value) <= 0:
                    raise ValueError
            except ValueError:
                parser_obj.error(f"invalid --id: {value}")
    if args.all and (args.session or args.user or args.id or getattr(args, "role", None)
                     or getattr(args, "before", None) or getattr(args, "after", None)):
        parser_obj.error("--all cannot be combined with filters")


def run_history(args, parser_obj) -> int:
    _validate(args, parser_obj)
    filters = _filters(args)
    filters.update({"role": args.role, "before": args.before, "after": args.after})
    if args.action == "list":
        rows = store.list_messages(filters, args.limit)
        total = store.count_filtered_messages(filters)
        print(f"[AIRA] {total} history row(s) matched; showing {len(rows)}")
        if not args.quiet:
            for row in rows:
                text = " ".join(row["text"].split())
                print(f"  #{row['id']} {row['role']:<5} {row.get('user_name') or '-':<16} {row['timestamp']}  {text[:72]}")
        return 0
    has_filters = any(value for value in filters.values())
    if not args.all and not has_filters:
        parser_obj.error("history clear requires --all or at least one filter")
    total = store.count_filtered_messages({} if args.all else filters)
    limit = min(total, args.limit) if not args.all else total
    print(f"[AIRA] would delete {limit} history row(s)")
    if not args.yes:
        print("[AIRA] dry-run only; nothing deleted. Add --yes to confirm.")
        return 0
    removed = store.delete_messages(delete_all=True) if args.all else store.delete_filtered_messages(
        filters, limit=args.limit,
    )
    print(f"[AIRA] deleted {removed} history row(s)")
    return 0


async def run_memory(args, parser_obj) -> int:
    if args.action == "search":
        if args.limit <= 0:
            parser_obj.error("--limit must be positive")
        rows = await search_memories_text(args.query, args.limit, args.session)
        print(f"[AIRA] {len(rows)} matching semantic result(s)")
        for index, row in enumerate(rows, 1):
            print(f"  {index}. {row['id']} {row.get('session_key') or '-'} score={row.get('score', 0):.2f} {row['text'][:100]}")
        return 0
    _validate(args, parser_obj)
    filters = _filters(args)
    if args.action == "list":
        rows = list_memories({**filters, "limit": args.limit})
        total = count_memories(filters)
        print(f"[AIRA] {total} memory record(s) matched; showing {len(rows)}")
        if not args.quiet:
            for row in rows:
                print(f"  {row['id']} {row.get('session_key') or '-':<24} {row.get('timestamp') or '-'} {row['text'][:72]}")
        return 0
    has_filters = any(value for value in filters.values())
    if not args.all and not has_filters:
        parser_obj.error("memory clear requires --all or at least one filter")
    total = count_memories({} if args.all else filters)
    print(f"[AIRA] would delete {total} memory record(s)")
    if not args.yes:
        print("[AIRA] dry-run only; nothing deleted. Add --yes to confirm.")
        return 0
    removed = clear_memories() if args.all else delete_memories(filters)
    print(f"[AIRA] deleted {removed} memory record(s)")
    return 0


def main(argv: list[str] | None = None) -> int:
    cli = parser()
    args = cli.parse_args(argv)
    try:
        if args.target == "history":
            return run_history(args, cli)
        return asyncio.run(run_memory(args, cli))
    except Exception as exc:
        print(f"[AIRA] {exc}", file=sys.stderr)
        return 1
    finally:
        store.close()


if __name__ == "__main__":
    raise SystemExit(main())
