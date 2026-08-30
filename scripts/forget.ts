/**
 * forget.ts — list / selectively delete the conversation context (SQLite) and
 * long-term memories (Chroma).
 *
 *   bun run scripts/forget.ts history list
 *   bun run scripts/forget.ts history clear --user 617201465437716493 --yes
 *   bun run scripts/forget.ts memory  list
 *   bun run scripts/forget.ts memory  clear --all --yes
 *
 * Safety: nothing is deleted unless --yes is present. Without --yes the command
 * only reports what *would* be removed (dry-run). A real history delete first
 * copies the SQLite file to .aira/backups/.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  clearMessages,
  backupDatabaseTo,
  closeHistoryDb,
  countMessages,
  deleteMessages,
  listMessages,
  type MessageFilter,
} from "../src/sql/history.js";
import {
  clearMemories,
  countMemories,
  deleteMemories,
  listMemories,
  searchMemories,
  type MemoryFilter,
} from "../src/memory/chroma.js";

const root = resolve(import.meta.dir, "..");
const dbPath = process.env.SQLITE_PATH ?? "./.aira/aira.db";

function usage(message?: string): never {
  if (message) console.error(`[FORGET] ${message}\n`);
  console.error(`usage: bun run scripts/forget.ts <history|memory> <list|search|clear> [flags]

history (SQLite conversation context, read fresh on every incoming message)
  list    [--user <id>] [--role user|model] [--before <iso>] [--after <iso>] [--limit N]
  clear   (--all | --user <id> | --role <r> | --before <iso> | --after <iso> | --id <n> ... | --limit N) [--yes]
          note: --limit with clear deletes the newest N matching rows

memory  (Chroma long-term memories, searched by vector on every message)
  list    [--user <id>] [--limit N]
  search  "<query>" [--limit N]
  clear   (--all | --user <id> | --id <uuid> ...) [--yes]

flags
  --yes   actually delete; without it the run is a dry-run
  --quiet hide row details

schema note: only user rows carry user_id -- Isla's own replies (role=model) are stored with
user_id NULL, so \`--user <id>\` removes just their side of the exchange. Use \`--all\` to wipe the
whole context window, or \`--role model\` to target her replies separately.

examples
  bun run scripts/forget.ts history list --user 617201465437716493 --limit 10
  bun run scripts/forget.ts history clear --id 36 --id 37 --yes
  bun run scripts/forget.ts history clear --before 2026-08-30 --yes
  bun run scripts/forget.ts memory clear --all --yes`);
  process.exit(message ? 2 : 0);
}

type Args = { _: string[]; flags: Record<string, string | boolean>; multi: Record<string, string[]> };

function parseArgs(argv: string[]): Args {
  const args: Args = { _: [], flags: {}, multi: {} };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!;
    if (!token.startsWith("--")) { args._.push(token); continue; }
    const key = token.slice(2);
    if (key === "yes" || key === "quiet" || key === "all") { args.flags[key] = true; continue; }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) usage(`--${key} needs a value`);
    i += 1;
    args.flags[key] = value;
    (args.multi[key] ??= []).push(value);
  }
  return args;
}

function preview(text: string, width = 72): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > width ? `${flat.slice(0, width - 1)}…` : flat;
}

function historyFilter(args: Args): MessageFilter {
  const filter: MessageFilter = {};
  if (args.flags.user) filter.userId = String(args.flags.user);
  if (args.flags.role) {
    const role = String(args.flags.role);
    if (role !== "user" && role !== "model") usage(`--role must be user or model, got ${role}`);
    filter.role = role;
  }
  if (args.flags.before) filter.before = String(args.flags.before);
  if (args.flags.after) filter.after = String(args.flags.after);
  const ids = (args.multi.id ?? []).map((id) => Number(id));
  if (ids.some((id) => !Number.isInteger(id) || id <= 0)) usage("--id must be an integer row id");
  if (ids.length) filter.ids = ids;
  if (args.flags.limit) {
    const limit = Number(args.flags.limit);
    if (!Number.isInteger(limit) || limit <= 0) usage(`--limit must be a positive integer, got ${args.flags.limit}`);
    filter.limit = limit;
  }
  return filter;
}

function memoryFilter(args: Args): MemoryFilter {
  const filter: MemoryFilter = {};
  if (args.flags.user) filter.userId = String(args.flags.user);
  const ids = args.multi.id ?? [];
  if (ids.length) filter.ids = ids;
  if (args.flags.limit) {
    const limit = Number(args.flags.limit);
    if (!Number.isInteger(limit) || limit <= 0) usage(`--limit must be a positive integer, got ${args.flags.limit}`);
    filter.limit = limit;
  }
  return filter;
}

function hasFilter(filter: Record<string, unknown>): boolean {
  return Object.values(filter).some((value) => (Array.isArray(value) ? value.length > 0 : value !== undefined));
}

function backupDatabase(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const target = resolve(root, `.aira/backups/aira-${stamp}.db`);
  mkdirSync(dirname(target), { recursive: true });
  backupDatabaseTo(target); // VACUUM INTO: consistent even while the bot is writing
  writeFileSync(`${target}.json`, JSON.stringify({ created: new Date().toISOString(), source: dbPath }, null, 2));
  return target;
}

async function runHistory(command: string, args: Args): Promise<void> {
  const quiet = Boolean(args.flags.quiet);
  if (command === "list") {
    const filter = historyFilter(args);
    const { limit: _omit, ...countFilter } = filter; // count ignores --limit, it caps the listing only
    const total = countMessages(countFilter);
    const rows = listMessages({ ...filter, limit: filter.limit ?? 20 });
    console.log(`[FORGET] messages matching filter: ${total} (showing ${rows.length})`);
    if (!quiet) for (const row of rows) console.log(`  #${String(row.id).padEnd(5)} ${row.role.padEnd(5)} ${(row.user ?? "-").padEnd(14)} ${row.timestamp}  ${preview(row.text)}`);
    closeHistoryDb();
    return;
  }
  if (command !== "clear") usage(`unknown history command '${command}'`);

  const all = Boolean(args.flags.all);
  const filter = historyFilter(args);
  if (all && hasFilter(filter)) usage("--all cannot be combined with filters");
  if (!all && !hasFilter(filter)) usage("history clear needs --all or at least one filter (--user/--role/--before/--after/--id)");

  const { limit: _omit, ...countFilter } = filter;
  // --limit on clear scopes the delete to the newest N rows, so report that many.
  const matching = all ? countMessages() : Math.min(countMessages(countFilter), filter.limit ?? Infinity);
  console.log(`[FORGET] history: ${matching} message(s) ${all ? "in total" : "match the filter"} (of ${countMessages()} stored)`);
  if (!args.flags.yes) {
    console.log("[FORGET] dry-run — nothing deleted. Re-run with --yes to apply.");
    closeHistoryDb();
    return;
  }
  if (!matching) { console.log("[FORGET] nothing to delete"); closeHistoryDb(); return; }
  const backup = backupDatabase();
  const removed = all ? clearMessages() : deleteMessages(filter);
  console.log(`[FORGET] deleted ${removed} message(s). Backup: ${backup.replace(`${root}/`, "")}`);
  closeHistoryDb();
}

async function runMemory(command: string, args: Args): Promise<void> {
  const quiet = Boolean(args.flags.quiet);
  if (command === "list") {
    const filter = memoryFilter(args);
    const total = await countMemories({ ...(filter.userId && { userId: filter.userId }) });
    const rows = await listMemories({ ...filter, limit: filter.limit ?? 20 });
    console.log(`[FORGET] memories: ${total} stored${filter.userId ? ` (user ${filter.userId})` : ""} (showing ${rows.length})`);
    if (!quiet) for (const row of rows) console.log(`  ${row.id}  ${(row.userId ?? "-").padEnd(20)} ${(row.timestamp ?? "-").slice(0, 19)}  ${preview(row.text)}`);
    return;
  }
  if (command === "search") {
    const query = args._[2];
    if (!query) usage('memory search needs a query, e.g. memory search "กาแฟ"');
    const limit = args.flags.limit ? Number(args.flags.limit) : 10;
    const rows = await searchMemories(query, limit);
    console.log(`[FORGET] ${rows.length} memories closest to: ${query}`);
    rows.forEach((row, index) => console.log(`  ${String(index + 1).padStart(2)}. ${row.id}  ${preview(row.text)}`));
    return;
  }
  if (command !== "clear") usage(`unknown memory command '${command}'`);

  const all = Boolean(args.flags.all);
  const filter = memoryFilter(args);
  if (all && hasFilter(filter)) usage("--all cannot be combined with filters");
  if (!all && !hasFilter(filter)) usage("memory clear needs --all or a filter (--user/--id)");

  const matching = all ? await countMemories() : await countMemories(filter);
  console.log(`[FORGET] memory: ${matching} memorie(s) ${all ? "in total" : "match the filter"}`);
  if (!args.flags.yes) {
    console.log("[FORGET] dry-run — nothing deleted. Re-run with --yes to apply.");
    return;
  }
  if (!matching) { console.log("[FORGET] nothing to delete"); return; }
  const removed = all ? await clearMemories() : await deleteMemories(filter);
  console.log(`[FORGET] deleted ${removed} memorie(s)`);
}

const args = parseArgs(process.argv.slice(2));
const target = args._[0];
const command = args._[1];
if (!target || target === "help" || args.flags.help) usage();
if (!command) usage(`missing subcommand for '${target}'`);

try {
  if (target === "history") await runHistory(command, args);
  else if (target === "memory") await runMemory(command, args);
  else usage(`unknown target '${target}' (expected history or memory)`);
} catch (error) {
  console.error(`[FORGET] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
