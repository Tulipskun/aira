import { Database } from "bun:sqlite";

export type HistoryMessage = {
  id?: number;
  role: "user" | "model";
  userId?: string;
  user?: string;
  text: string;
  timestamp: string;
  fileName?: string;
};

const db = new Database(process.env.SQLITE_PATH ?? "./data/aira.db", { create: true });
db.run(`CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  role TEXT NOT NULL CHECK (role IN ('user', 'model')),
  user_id TEXT,
  user_name TEXT,
  text TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  file_name TEXT
)`);
db.run("CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp)");
db.run("CREATE INDEX IF NOT EXISTS idx_messages_user_id ON messages(user_id)");

const insert = db.prepare(`INSERT INTO messages
  (role, user_id, user_name, text, timestamp, file_name)
  VALUES (?, ?, ?, ?, ?, ?)`);

export function saveMessage(message: HistoryMessage): number {
  const result = insert.run(
    message.role,
    message.userId ?? null,
    message.user ?? null,
    message.text,
    message.timestamp,
    message.fileName ?? null,
  );
  return Number(result.lastInsertRowid);
}

export function getHistory(limit = 50): HistoryMessage[] {
  return db.query(`
    SELECT id, role, user_id AS userId, user_name AS user, text, timestamp, file_name AS fileName
    FROM messages ORDER BY id DESC LIMIT ?
  `).all(limit).reverse() as HistoryMessage[];
}

export function closeHistoryDb(): void {
  db.close();
}
