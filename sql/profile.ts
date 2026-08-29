import { Database } from "bun:sqlite";

export type UserProfile = {
  userId: string;
  name: string;
  nicknames: string[];
  facts: string[];
};

const db = new Database(process.env.SQLITE_PATH ?? "./data/aira.db", { create: true });
db.run(`CREATE TABLE IF NOT EXISTS user_profiles (
  user_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  nicknames_json TEXT NOT NULL DEFAULT '[]',
  facts_json TEXT NOT NULL DEFAULT '[]'
)`);

export function getUserProfile(userId: string): UserProfile | null {
  const row = db.query(`SELECT user_id AS userId, name, nicknames_json AS nicknamesJson, facts_json AS factsJson FROM user_profiles WHERE user_id = ?`).get(userId) as { userId: string; name: string; nicknamesJson: string; factsJson: string } | null;
  if (!row) return null;
  return {
    userId: row.userId,
    name: row.name,
    nicknames: JSON.parse(row.nicknamesJson) as string[],
    facts: JSON.parse(row.factsJson) as string[],
  };
}

export function upsertUserProfile(profile: UserProfile): void {
  db.query(`
    INSERT INTO user_profiles (user_id, name, nicknames_json, facts_json)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      name = excluded.name,
      nicknames_json = excluded.nicknames_json,
      facts_json = excluded.facts_json
  `).run(profile.userId, profile.name, JSON.stringify(profile.nicknames), JSON.stringify(profile.facts));
}

export function getUserProfiles(userIds: string[]): UserProfile[] {
  return userIds.map(getUserProfile).filter((profile): profile is UserProfile => profile !== null);
}
