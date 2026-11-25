import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const path = process.env.SQLITE_PATH ?? "./.aira/aira.db";
mkdirSync(dirname(path), { recursive: true });
const db = new Database(path, { create: true });
db.run("PRAGMA busy_timeout = 5000");
db.run(`CREATE TABLE IF NOT EXISTS character_relationships (
  character_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  relationship TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (character_id, user_id)
)`);

export function getCharacterRelationship(characterId: string, userId: string): string {
  const row = db.query<{ relationship: string }, [string, string]>(
    "SELECT relationship FROM character_relationships WHERE character_id = ? AND user_id = ?",
  ).get(characterId, userId);
  return row?.relationship ?? "ยังไม่เคยสร้างความสัมพันธ์";
}

export function saveCharacterRelationship(characterId: string, userId: string, relationship: string): void {
  const normalized = relationship.trim();
  if (!normalized || normalized.length > 1200) return;
  db.prepare(`INSERT INTO character_relationships (character_id, user_id, relationship, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(character_id, user_id) DO UPDATE SET
      relationship = excluded.relationship,
      updated_at = excluded.updated_at`).run(characterId, userId, normalized, new Date().toISOString());
}

export function closeCharacterRelationshipsDb(): void {
  db.close();
}
