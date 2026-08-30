import { Database, type Changes } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type HistoryMessage = {
  id?: number;
  role: "user" | "model";
  userId?: string;
  user?: string;
  text: string;
  /** One-line recap of a model turn, produced by Gemini 1 alongside its reply. Never shown to users. */
  summary?: string | null;
  timestamp: string;
  fileName?: string;
};

const path = process.env.SQLITE_PATH ?? "./.aira/aira.db";
mkdirSync(dirname(path), { recursive: true });
const db = new Database(path, { create: true });
// bun:sqlite defaults busy_timeout to 0. The bot keeps this file open and the forget CLI writes
// to it concurrently, so a colliding writer would fail instantly with SQLITE_BUSY instead of waiting.
db.run("PRAGMA busy_timeout = 5000");
db.run(`CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  role TEXT NOT NULL CHECK (role IN ('user', 'model')),
  user_id TEXT,
  user_name TEXT,
  text TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  file_name TEXT
)`);
// Gemini 1 now answers as { Isla, summery }; the recap belongs next to the reply it describes but
// must not be part of it, so it gets its own column. Added lazily because existing databases were
// created without it and CREATE TABLE IF NOT EXISTS never alters a table that already exists.
if (!db.query(`SELECT name FROM pragma_table_info('messages') WHERE name = 'summary'`).get()) {
  db.run("ALTER TABLE messages ADD COLUMN summary TEXT");
}
db.run("CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp)");
db.run("CREATE INDEX IF NOT EXISTS idx_messages_user_id ON messages(user_id)");

const insert = db.prepare(`INSERT INTO messages
  (role, user_id, user_name, text, timestamp, file_name, summary)
  VALUES (?, ?, ?, ?, ?, ?, ?)`);

export function saveMessage(message: HistoryMessage): number {
  const result = insert.run(message.role, message.userId ?? null, message.user ?? null, message.text, message.timestamp, message.fileName ?? null, message.summary ?? null);
  return Number(result.lastInsertRowid);
}

const SELECT_COLUMNS = `SELECT id, role, user_id AS userId, user_name AS user, text, summary, timestamp, file_name AS fileName FROM messages`;

export function getHistory(limit = 50): HistoryMessage[] {
  return db.query(`${SELECT_COLUMNS} ORDER BY id DESC LIMIT ?`).all(limit).reverse() as HistoryMessage[];
}

export type MessageFilter = { userId?: string; role?: "user" | "model"; before?: string; after?: string; ids?: number[]; limit?: number };

function filterSql(filter: MessageFilter): { where: string; values: (string | number)[] } {
  const clauses: string[] = [];
  const values: (string | number)[] = [];
  if (filter.userId) { clauses.push("user_id = ?"); values.push(filter.userId); }
  if (filter.role) { clauses.push("role = ?"); values.push(filter.role); }
  if (filter.before) { clauses.push("timestamp < ?"); values.push(filter.before); }
  if (filter.after) { clauses.push("timestamp >= ?"); values.push(filter.after); }
  if (filter.ids?.length) {
    clauses.push(`id IN (${filter.ids.map(() => "?").join(", ")})`);
    values.push(...filter.ids);
  }
  return { where: clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "", values };
}

export function countMessages(filter: MessageFilter = {}): number {
  const { where, values } = filterSql(filter);
  const stmt = db.query<{ n: number }, (string | number)[]>(`SELECT COUNT(*) AS n FROM messages${where}`);
  return Number(stmt.get(...values)?.n ?? 0);
}

export function listMessages(filter: MessageFilter = {}): HistoryMessage[] {
  const { where, values } = filterSql(filter);
  const limit = filter.limit ?? 20;
  return db.query(`${SELECT_COLUMNS}${where} ORDER BY id DESC LIMIT ?`).all(...values, limit).reverse() as HistoryMessage[];
}

export function deleteMessages(filter: MessageFilter = {}): number {
  const { where, values } = filterSql(filter);
  if (!where && !filter.limit) throw new Error("deleteMessages refuses to delete everything without a filter -- pass --all explicitly");
  // Newest rows first when a limit is given, so `--limit 10` means "the last 10 messages".
  const sql = filter.limit
    ? `DELETE FROM messages WHERE id IN (SELECT id FROM messages${where} ORDER BY id DESC LIMIT ?)`
    : `DELETE FROM messages${where}`;
  const args = filter.limit ? [...values, filter.limit] : values;
  return Number(db.prepare<Changes, (string | number)[]>(sql).run(...args).changes);
}

export function clearMessages(): number {
  return Number(db.run(`DELETE FROM messages`).changes);
}

/**
 * Consistent snapshot of the database to `target`, safe to take while the bot is
 * writing (SQLite copies through a read transaction). `copyFileSync` can capture a
 * torn page when journal_mode is `delete`. Fails if `target` already exists.
 */
export function backupDatabaseTo(target: string): void {
  db.prepare<Changes, [string]>("VACUUM INTO ?").run(target);
}

export function closeHistoryDb(): void { db.close(); }
