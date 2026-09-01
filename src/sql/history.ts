import { Database, type Changes } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { LEGACY_SESSION_KEY, userSessionKey } from "../session-keys.js";

// Part of this module's contract: `migrateMessageSessions()` writes this key, so a caller that needs
// to read (or clean up) unattributable rows must be able to name it without importing a third module.
export { LEGACY_SESSION_KEY };

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
  /**
   * Which conversation stream this row belongs to (`user:<id>` or `group:<channel>`). See
   * sql/sessions.ts. NULL only on rows the startup backfill could not attribute to anybody, which
   * are filed under LEGACY_SESSION_KEY and never read.
   */
  sessionKey?: string;
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
  file_name TEXT,
  session_key TEXT
)`);
// Gemini 1 now answers as { Isla, summery }; the recap belongs next to the reply it describes but
// must not be part of it, so it gets its own column. Added lazily because existing databases were
// created without it and CREATE TABLE IF NOT EXISTS never alters a table that already exists.
if (!db.query(`SELECT name FROM pragma_table_info('messages') WHERE name = 'summary'`).get()) {
  db.run("ALTER TABLE messages ADD COLUMN summary TEXT");
}
// Session scoping: every row belongs to exactly one conversation stream. Added lazily for the same
// reason as `summary` — CREATE TABLE IF NOT EXISTS never alters an existing table.
if (!db.query(`SELECT name FROM pragma_table_info('messages') WHERE name = 'session_key'`).get()) {
  db.run("ALTER TABLE messages ADD COLUMN session_key TEXT");
}
db.run("CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp)");
db.run("CREATE INDEX IF NOT EXISTS idx_messages_user_id ON messages(user_id)");
db.run("CREATE INDEX IF NOT EXISTS idx_messages_session_key ON messages(session_key)");

/**
 * Give every pre-scoping row a session key.
 *
 * `messages` was one global stream: `getHistory(50)` returned the last 50 rows across *all* users,
 * and Isla's own replies were written with `user_id NULL`. So the column cannot be filled from the
 * row itself — a model turn has no author id. It is filled from the user turn it answers: rows are
 * read in insertion order, the running `user_id` of the most recent `role='user'` row owns every
 * model row until the next user speaks. That reproduces, per person, the exchange they actually had.
 *
 * Idempotent (only NULL rows are touched) and transactional, so an interrupted start either fully
 * backfills or not at all and can be retried. Returns the counts so the caller can log what it did
 * and a test can assert them.
 */
export function migrateMessageSessions(): { backfilled: number; unattributed: number; alreadyKeyed: number } {
  const rows = db
    .query<{ id: number; role: string; userId: string | null }, []>(
      `SELECT id, role, user_id AS userId FROM messages WHERE session_key IS NULL ORDER BY id ASC`,
    )
    .all();
  if (!rows.length) {
    const keyed = Number(db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM messages WHERE session_key IS NOT NULL`).get()?.n ?? 0);
    return { backfilled: 0, unattributed: 0, alreadyKeyed: keyed };
  }

  const setKey = db.prepare(`UPDATE messages SET session_key = ? WHERE id = ?`);
  let owner: string | null = null;
  let backfilled = 0;
  let unattributed = 0;
  db.transaction(() => {
    for (const row of rows) {
      if (row.role === "user" && row.userId) owner = row.userId;
      const key = row.role === "user" && row.userId
        ? userSessionKey(row.userId)
        : owner
          ? userSessionKey(owner)
          : LEGACY_SESSION_KEY;
      if (!owner && row.role !== "user") unattributed += 1;
      setKey.run(key, row.id);
      backfilled += 1;
    }
  })();
  return { backfilled, unattributed, alreadyKeyed: 0 };
}

// Runs at module load, like migrateUserProfiles() does in sql/profile.ts: a database that predates
// session scoping must not be readable in a half-scoped state, and every query below filters on
// session_key, so an un-migrated table would silently return no history at all.
{
  const result = migrateMessageSessions();
  if (result.backfilled) {
    console.log(`[SESSIONS] history backfilled: ${result.backfilled} row(s) keyed` +
      (result.unattributed ? `, ${result.unattributed} unattributable -> ${LEGACY_SESSION_KEY}` : ""));
  }
}

const insert = db.prepare(`INSERT INTO messages
  (role, user_id, user_name, text, timestamp, file_name, summary, session_key)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);

/**
 * A row must be written WITH its session key. Without this the compiler cannot tell a correct call
 * from one that simply forgot, and a NULL-keyed row is invisible to every `getHistory` — a turn that
 * silently vanishes from context instead of a build error.
 */
export type NewHistoryMessage = HistoryMessage & { sessionKey: string };

export function saveMessage(message: NewHistoryMessage): number {
  const result = insert.run(message.role, message.userId ?? null, message.user ?? null, message.text, message.timestamp, message.fileName ?? null, message.summary ?? null, message.sessionKey);
  return Number(result.lastInsertRowid);
}

const SELECT_COLUMNS = `SELECT id, role, user_id AS userId, user_name AS user, text, summary, timestamp, file_name AS fileName, session_key AS sessionKey FROM messages`;

/**
 * The last `limit` turns of ONE session.
 *
 * This used to be `ORDER BY id DESC LIMIT ?` over the whole table — a single global context window
 * shared by every user, which is what made two people's conversations bleed into each other.
 * `sessionKey` has no default on purpose: a call site that forgot it would silently read the legacy
 * bucket and answer with an empty history, which looks like amnesia rather than a bug.
 */
export function getHistory(limit: number, sessionKey: string): HistoryMessage[] {
  return db
    .query(`${SELECT_COLUMNS} WHERE session_key = ? ORDER BY id DESC LIMIT ?`)
    .all(sessionKey, limit)
    .reverse() as HistoryMessage[];
}

export type MessageFilter = { userId?: string; role?: "user" | "model"; before?: string; after?: string; ids?: number[]; limit?: number; sessionKey?: string };

function filterSql(filter: MessageFilter): { where: string; values: (string | number)[] } {
  const clauses: string[] = [];
  const values: (string | number)[] = [];
  if (filter.userId) { clauses.push("user_id = ?"); values.push(filter.userId); }
  if (filter.sessionKey) { clauses.push("session_key = ?"); values.push(filter.sessionKey); }
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
