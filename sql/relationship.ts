import { Database } from "bun:sqlite";

export type Relationship = {
  userId: string;
  userName: string;
  state: string;
  xp: number;
  affinity: number;
};

const db = new Database(process.env.SQLITE_PATH ?? "./data/aira.db", { create: true });
db.run(`CREATE TABLE IF NOT EXISTS relationships (
  user_id TEXT PRIMARY KEY,
  user_name TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'stranger',
  xp INTEGER NOT NULL DEFAULT 0,
  affinity REAL NOT NULL DEFAULT 0
)`);

export function getRelationship(userId: string): Relationship | null {
  return db.query(`
    SELECT user_id AS userId, user_name AS userName, state, xp, affinity
    FROM relationships WHERE user_id = ?
  `).get(userId) as Relationship | null;
}

export function getRelationships(userIds: string[]): Relationship[] {
  const ids = [...new Set(userIds.filter(Boolean))];
  if (!ids.length) return [];
  const placeholders = ids.map(() => "?").join(",");
  return db.query(`
    SELECT user_id AS userId, user_name AS userName, state, xp, affinity
    FROM relationships WHERE user_id IN (${placeholders})
  `).all(...ids) as Relationship[];
}

export function upsertRelationship(value: Relationship): void {
  db.query(`
    INSERT INTO relationships (user_id, user_name, state, xp, affinity)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      user_name = excluded.user_name,
      state = excluded.state,
      xp = excluded.xp,
      affinity = excluded.affinity
  `).run(value.userId, value.userName, value.state, value.xp, value.affinity);
}

export function adjustRelationshipStats(userId: string, delta: { affinity?: number; xp?: number; state?: string; userName?: string }): void {
  const current = getRelationship(userId) ?? {
    userId,
    userName: delta.userName ?? userId,
    state: delta.state ?? "stranger",
    xp: 0,
    affinity: 0,
  };
  upsertRelationship({
    userId,
    userName: delta.userName ?? current.userName,
    state: delta.state ?? current.state,
    xp: current.xp + (delta.xp ?? 0),
    affinity: current.affinity + (delta.affinity ?? 0),
  });
}
