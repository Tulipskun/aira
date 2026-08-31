import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { bondLabel, bondLevel, isBond, resolveBondChange, type BondLevel } from "./bonds.js";

/**
 * One user, one row.
 *
 * This table used to be two: `user_profiles` (name, nicknames, facts) and `relationships`
 * (state, xp, affinity). They were keyed by the same `user_id` and always read together, so they
 * are merged here. `migrateUserProfiles()` moves the old data across and then removes the
 * leftovers; see the notes on each column for what came from where.
 */
export type UserFact = {
  text: string;
  /** ISO-8601 UTC, or "" for facts that predate per-fact timestamps. */
  timestamp: string;
};

export type UserProfile = {
  userId: string;
  userName: string;
  /** Nicknames Isla gave this user. Was `nicknames_json` / `nicknames: string[]`. */
  nickname: string[];
  /** Rung on the ladder in `bonds.ts`. Was `relationships.state`. */
  bond: BondLevel;
  xp: number;
  trust: number;
  /** Was `relationships.affinity`. */
  affection: number;
  familiarity: number;
  /** Many facts per user. Was a flat `string[]`. */
  facts: UserFact[];
};

/** Fields a caller may write. `userId` always identifies the row. */
export type UserProfilePatch = Partial<Omit<UserProfile, "userId" | "bond">> & {
  userId: string;
  bond?: BondLevel | string;
};

/** Facts are kept newest-first and capped, because the whole list goes into a prompt every turn. */
export const MAX_FACTS = 40;

const path = process.env.SQLITE_PATH ?? "./.aira/aira.db";
mkdirSync(dirname(path), { recursive: true });
const db = new Database(path, { create: true });
// The bot keeps this file open and the forget CLI writes to it concurrently.
db.run("PRAGMA busy_timeout = 5000");

/** The table as it should look when migration is finished. */
const DESIRED_COLUMNS: [name: string, ddl: string][] = [
  ["user_id", "TEXT PRIMARY KEY"],
  ["user_name", "TEXT NOT NULL DEFAULT ''"],
  ["nickname_json", "TEXT NOT NULL DEFAULT '[]'"],
  ["bond", "TEXT NOT NULL DEFAULT 'stranger'"],
  ["xp", "INTEGER NOT NULL DEFAULT 0"],
  ["trust", "REAL NOT NULL DEFAULT 0"],
  ["affection", "REAL NOT NULL DEFAULT 0"],
  ["familiarity", "REAL NOT NULL DEFAULT 0"],
  ["facts_json", "TEXT NOT NULL DEFAULT '[]'"],
];

function columnsOf(table: string): Set<string> {
  if (!db.query(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table)) return new Set();
  return new Set((db.query(`SELECT name FROM pragma_table_info(?)`).all(table) as { name: string }[]).map((r) => r.name));
}

/**
 * Legacy columns a plain INSERT cannot skip: NOT NULL **and** no default.
 *
 * The real database has `user_profiles.name TEXT NOT NULL` with no default, so inserting a
 * relationship-only user (someone who never had a profile row) violates it — found by
 * `test-reply-reference.ts`, which builds that exact schema. Normally harmless because the
 * migration drops these columns, but it is fatal in additive mode (`AIRA_KEEP_LEGACY_SCHEMA`),
 * where they stay for the lifetime of the old process. Both writers fill them.
 *
 * Values are derived from data the caller already has, so nothing is invented: `name` gets the
 * display name, anything ending in `_json` gets an empty array.
 */
function legacyRequiredColumns(): { column: string; value: (userName: string) => string }[] {
  // `SELECT *` on purpose: naming `notnull`/`dflt_value` (even quoted) is rejected by this SQLite
  // build's parser when combined with an alias, while `SELECT *` returns them fine.
  const rows = db.query(`SELECT * FROM pragma_table_info('user_profiles')`).all() as unknown as {
    name: string;
    notnull: number;
    dflt_value: string | null;
  }[];
  const fillers: { column: string; value: (userName: string) => string }[] = [];
  for (const info of rows) {
    if (!info.notnull || info.dflt_value !== null) continue;
    if (DESIRED_COLUMNS.some(([name]) => name === info.name)) continue;
    fillers.push({
      column: info.name,
      value: info.name.endsWith("_json") ? () => "[]" : (userName) => userName,
    });
  }
  return fillers;
}

/** Recomputed once after the migration, because the columns cannot change while this process runs. */
let legacyFillers: { column: string; value: (userName: string) => string }[] = [];

/**
 * When set, the migration is **additive only**: it adds the merged columns, copies data across and
 * leaves `relationships` plus the legacy `user_profiles` columns in place.
 *
 * Needed when migrating a database a running bot still has open. That process has the *old*
 * module code in memory — it reads `user_profiles.name`/`nicknames_json` and writes
 * `relationships` — so removing either from under it would error on the next turn. Restart with
 * the flag unset (the normal state) and the leftovers are dropped.
 */
function keepLegacySchema(): boolean {
  const raw = process.env.AIRA_KEEP_LEGACY_SCHEMA ?? "";
  return /^(1|true|yes|on)$/i.test(raw);
}

/**
 * Bring `user_profiles` up to the merged schema and fold `relationships` into it.
 *
 * Written to be idempotent and to work on three starting points: a brand-new database, the old
 * two-table layout, and a half-migrated one (the bot was restarted mid-development). Every step
 * checks what is actually present instead of assuming, because `CREATE TABLE IF NOT EXISTS` never
 * alters a table that already exists.
 *
 * Exported so tests can run it against a hand-built legacy database.
 */
export function migrateUserProfiles(): { created: boolean; mergedRelationships: number; droppedRelationships: boolean } {
  const had = columnsOf("user_profiles");
  const created = had.size === 0;

  if (created) {
    db.run(`CREATE TABLE user_profiles (\n  ${DESIRED_COLUMNS.map(([n, t]) => `${n} ${t}`).join(",\n  ")}\n)`);
  } else {
    // Add whatever the new shape needs. NOT NULL with a DEFAULT is legal on an existing table:
    // SQLite fills the default into every existing row.
    for (const [name, ddl] of DESIRED_COLUMNS) {
      if (had.has(name)) continue;
      // PRIMARY KEY cannot be added to an existing table; user_id is always present in practice.
      const addable = name === "user_id" ? "TEXT" : ddl;
      db.run(`ALTER TABLE user_profiles ADD COLUMN ${name} ${addable}`);
    }
  }

  const now = columnsOf("user_profiles");
  let mergedRelationships = 0;

  // ---- legacy user_profiles: name -> user_name, nicknames_json -> nickname_json ----
  if (had.has("name") && now.has("user_name")) {
    db.run(`UPDATE user_profiles SET user_name = name WHERE (user_name = '' OR user_name IS NULL) AND name IS NOT NULL`);
  }
  if (had.has("nicknames_json") && now.has("nickname_json")) {
    db.run(`UPDATE user_profiles SET nickname_json = nicknames_json
            WHERE nickname_json = '[]' AND nicknames_json IS NOT NULL AND nicknames_json <> '[]'`);
  }

  // ---- legacy facts: a flat string array becomes [{text, timestamp}] ----
  // Done before merging relationships so the two never fight over the same column.
  if (now.has("facts_json")) {
    const rows = db.query(`SELECT user_id AS userId, facts_json AS factsJson FROM user_profiles`).all() as {
      userId: string;
      factsJson: string;
    }[];
    for (const row of rows) {
      const converted = normalizeFacts(row.factsJson);
      if (converted.serialized === row.factsJson) continue;
      db.query(`UPDATE user_profiles SET facts_json = ? WHERE user_id = ?`).run(converted.serialized, row.userId);
    }
  }

  // ---- legacy relationships: state -> bond, affinity -> affection ----
  if (columnsOf("relationships").size > 0) {
    const rel = columnsOf("relationships");
    const select = [
      `user_id`,
      rel.has("user_name") ? `user_name` : `'' AS user_name`,
      rel.has("state") ? `state` : `'stranger' AS state`,
      rel.has("xp") ? `xp` : `0 AS xp`,
      rel.has("affinity") ? `affinity AS affection` : rel.has("affection") ? `affection` : `0 AS affection`,
    ].join(", ");
    const rows = db.query(`SELECT ${select} FROM relationships`).all() as {
      user_id: string;
      user_name: string | null;
      state: string | null;
      xp: number | null;
      affection: number | null;
    }[];

    // Fill any legacy NOT NULL column the INSERT cannot skip (see legacyRequiredColumns).
    const fillers = legacyRequiredColumns();
    const merge = db.query(`
      INSERT INTO user_profiles (user_id, user_name, bond, xp, affection${fillers.length ? ", " + fillers.map((f) => f.column).join(", ") : ""})
      VALUES (?, ?, ?, ?, ?${fillers.length ? ", " + fillers.map(() => "?").join(", ") : ""})
      ON CONFLICT(user_id) DO UPDATE SET
        user_name = COALESCE(NULLIF(user_profiles.user_name, ''), excluded.user_name),
        bond      = CASE WHEN user_profiles.bond = 'stranger' THEN excluded.bond ELSE user_profiles.bond END,
        xp        = CASE WHEN user_profiles.xp = 0 THEN excluded.xp ELSE user_profiles.xp END,
        affection = CASE WHEN user_profiles.affection = 0 THEN excluded.affection ELSE user_profiles.affection END
    `);

    for (const row of rows) {
      const bond = isBond(row.state) ? row.state : "stranger";
      const userName = row.user_name ?? row.user_id;
      merge.run(
        row.user_id,
        userName,
        bond,
        Number.isFinite(row.xp) ? Number(row.xp) : 0,
        Number.isFinite(row.affection) ? Number(row.affection) : 0,
        ...fillers.map((f) => f.value(userName)),
      );
      mergedRelationships++;
    }

    // Only drop the old table once every row is provably present in the new one.
    const missing = db.query(
      `SELECT COUNT(*) AS c FROM relationships
       WHERE user_id NOT IN (SELECT user_id FROM user_profiles)`,
    ).get() as { c: number };
    if (missing.c > 0) {
      console.warn(
        `[SQL] kept relationships table: ${missing.c} row(s) did not make it into user_profiles`,
      );
    } else if (keepLegacySchema()) {
      // A bot process that is already running still has the old statements compiled and writes to
      // `relationships`; dropping it from under that process would error on the next turn.
      console.log(`[SQL] user_profiles migrated; relationships kept (AIRA_KEEP_LEGACY_SCHEMA)`);
    } else {
      db.run(`DROP TABLE relationships`);
    }
  }

  // ---- drop the columns that were copied across ----
  if (!keepLegacySchema()) {
    for (const legacy of ["name", "nicknames_json", "affinity"]) {
      if (!had.has(legacy) || !now.has(legacy)) continue;
      // `affinity` may hold data if a database had it on user_profiles instead of `affection`.
      if (legacy === "affinity" && now.has("affection")) {
        db.run(`UPDATE user_profiles SET affection = affinity WHERE affection = 0 AND affinity IS NOT NULL`);
      }
      try {
        db.run(`ALTER TABLE user_profiles DROP COLUMN ${legacy}`);
      } catch (error) {
        console.warn(`[SQL] could not drop user_profiles.${legacy}: ${(error as Error).message}`);
      }
    }
  }

  return { created, mergedRelationships, droppedRelationships: !columnsOf("relationships").has("user_id") };
}

migrateUserProfiles();
// Recomputed after the migration so `upsertUserProfile` only fills columns that survived it
// (additive mode). Before this line runs, the merge path queries the fillers directly.
legacyFillers = legacyRequiredColumns();

const SELECT = `SELECT user_id AS userId, user_name AS userName, nickname_json AS nicknameJson,
  bond, xp, trust, affection, familiarity, facts_json AS factsJson FROM user_profiles`;

/**
 * Read a row defensively.
 *
 * `bond` has no CHECK constraint (so a level can be added without ALTER TABLE), and facts were
 * once a flat string array. Anything unrecognisable degrades to the default rather than throwing
 * in the middle of a reply.
 */
function hydrate(row: {
  userId: string;
  userName: string | null;
  nicknameJson: string | null;
  bond: string | null;
  xp: number | null;
  trust: number | null;
  affection: number | null;
  familiarity: number | null;
  factsJson: string | null;
}): UserProfile {
  return {
    userId: row.userId,
    userName: row.userName || row.userId,
    nickname: normalizeStringArray(row.nicknameJson),
    bond: isBond(row.bond) ? row.bond : "stranger",
    xp: Number.isFinite(row.xp) ? Number(row.xp) : 0,
    trust: Number.isFinite(row.trust) ? Number(row.trust) : 0,
    affection: Number.isFinite(row.affection) ? Number(row.affection) : 0,
    familiarity: Number.isFinite(row.familiarity) ? Number(row.familiarity) : 0,
    facts: normalizeFacts(row.factsJson).facts,
  };
}

function normalizeStringArray(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === "string" && v.trim() !== "").map((v) => v.trim());
  } catch {
    return [];
  }
}

/**
 * Accept both fact shapes: the current `[{text, timestamp}]` and the legacy `["text"]`.
 * Returns the list plus the JSON that should be stored, so the migration can tell whether a row
 * actually needed rewriting.
 */
function normalizeFacts(raw: string | null | undefined): { facts: UserFact[]; serialized: string } {
  if (!raw) return { facts: [], serialized: "[]" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { facts: [], serialized: "[]" };
  }
  if (!Array.isArray(parsed)) return { facts: [], serialized: "[]" };

  const facts: UserFact[] = [];
  for (const item of parsed) {
    if (typeof item === "string") {
      if (item.trim()) facts.push({ text: item.trim(), timestamp: "" });
      continue;
    }
    if (item && typeof item === "object") {
      const record = item as Record<string, unknown>;
      const text = typeof record.text === "string" ? record.text.trim() : "";
      if (!text) continue;
      const timestamp = typeof record.timestamp === "string" ? record.timestamp : "";
      facts.push({ text, timestamp });
    }
  }
  return { facts, serialized: JSON.stringify(facts) };
}

export function getUserProfile(userId: string): UserProfile | null {
  const row = db.query(`${SELECT} WHERE user_id = ?`).get(userId) as Parameters<typeof hydrate>[0] | null;
  return row ? hydrate(row) : null;
}

export function getUserProfiles(userIds: string[]): UserProfile[] {
  const ids = [...new Set(userIds.filter(Boolean))];
  if (!ids.length) return [];
  const placeholders = ids.map(() => "?").join(",");
  const rows = db.query(`${SELECT} WHERE user_id IN (${placeholders})`).all(...ids) as Parameters<typeof hydrate>[0][];
  return rows.map(hydrate);
}

/**
 * Create or update one user row. Only the fields present in `patch` are written, so a caller
 * adjusting xp never has to read the row first and never clobbers someone's facts.
 */
export function upsertUserProfile(patch: UserProfilePatch): UserProfile | null {
  const columns: string[] = ["user_id"];
  const values: (string | number | null)[] = [patch.userId];
  const updates: string[] = [];

  const add = (column: string, value: string | number | null) => {
    columns.push(column);
    values.push(value);
    updates.push(`${column} = excluded.${column}`);
  };

  if (patch.userName !== undefined) add("user_name", patch.userName);
  if (patch.nickname !== undefined) add("nickname_json", JSON.stringify(patch.nickname));
  if (patch.bond !== undefined) add("bond", isBond(patch.bond) ? patch.bond : "stranger");
  if (patch.xp !== undefined) add("xp", Math.trunc(Number(patch.xp) || 0));
  if (patch.trust !== undefined) add("trust", Number(patch.trust) || 0);
  if (patch.affection !== undefined) add("affection", Number(patch.affection) || 0);
  if (patch.familiarity !== undefined) add("familiarity", Number(patch.familiarity) || 0);
  if (patch.facts !== undefined) add("facts_json", JSON.stringify(normalizeFacts(JSON.stringify(patch.facts)).facts));

  // A brand-new row must also satisfy any legacy NOT NULL column still in the table.
  const name = patch.userName ?? getUserProfile(patch.userId)?.userName ?? patch.userId;
  for (const filler of legacyFillers) {
    if (columns.includes(filler.column)) continue;
    add(filler.column, filler.value(name));
  }

  if (updates.length) {
    db.query(
      `INSERT INTO user_profiles (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})
       ON CONFLICT(user_id) DO UPDATE SET ${updates.join(", ")}`,
    ).run(...values);
  }
  return getUserProfile(patch.userId);
}

/**
 * Add to a user's numeric stats, creating the row on first contact.
 *
 * Numbers are clamped to 0..100 for the percentage-like stats (trust, affection, familiarity);
 * `xp` is open-ended because it is a running total.
 */
export const STAT_LIMITS: Record<string, number> = { trust: 100, affection: 100, familiarity: 100 };

export function adjustProfileStats(
  userId: string,
  delta: { xp?: number; trust?: number; affection?: number; familiarity?: number; userName?: string },
): UserProfile | null {
  const current = getUserProfile(userId) ?? {
    userId,
    userName: delta.userName ?? userId,
    nickname: [],
    bond: "stranger" as BondLevel,
    xp: 0,
    trust: 0,
    affection: 0,
    familiarity: 0,
    facts: [],
  };
  const clamp = (key: "trust" | "affection" | "familiarity") => {
    const limit = STAT_LIMITS[key];
    return Math.max(0, Math.min(limit, current[key] + (delta[key] ?? 0)));
  };
  return upsertUserProfile({
    userId,
    userName: delta.userName ?? current.userName,
    xp: current.xp + (Number.isFinite(delta.xp) ? Math.trunc(delta.xp as number) : 0),
    trust: clamp("trust"),
    affection: clamp("affection"),
    familiarity: clamp("familiarity"),
  });
}

/**
 * Move a user to another bond rung, applying the ladder rules from `bonds.ts`.
 *
 * Refuses an unknown rung and a rung above the user's ceiling (a sibling or family member cannot
 * become `lover`). Returns the stored bond either way, plus why a request was refused.
 */
export function setBond(
  userId: string,
  to: string,
  userName?: string,
): { ok: boolean; profile: UserProfile | null; bond: BondLevel; reason?: string } {
  const current = getUserProfile(userId);
  const from = current?.bond ?? "stranger";
  const resolved = resolveBondChange(from, to);
  if (!resolved) {
    const reason = !isBond(to)
      ? `unknown bond "${to}"`
      : `cannot go from ${from} (level ${bondLevel(from)}) to ${to} (level ${bondLevel(to)})`;
    return { ok: false, profile: current, bond: from, reason };
  }
  if (resolved === from) {
    if (userName && userName !== current?.userName) {
      return { ok: true, profile: upsertUserProfile({ userId, userName }), bond: from };
    }
    return { ok: true, profile: current, bond: from };
  }
  return { ok: true, profile: upsertUserProfile({ userId, bond: resolved, ...(userName ? { userName } : {}) }), bond: resolved };
}

/**
 * Append facts, newest first, dropping duplicates and the oldest beyond `MAX_FACTS`.
 * Returns how many were actually added.
 */
export function addFacts(userId: string, facts: string[], timestamp = new Date().toISOString(), userName?: string): number {
  const incoming = facts.map((f) => (typeof f === "string" ? f.trim() : "")).filter(Boolean);
  if (!incoming.length) return 0;
  const current = getUserProfile(userId);
  const existing = new Set((current?.facts ?? []).map((f) => f.text.toLowerCase()));
  const fresh: UserFact[] = [];
  for (const text of incoming) {
    if (existing.has(text.toLowerCase())) continue;
    existing.add(text.toLowerCase());
    fresh.push({ text, timestamp });
  }
  if (!fresh.length) return 0;
  upsertUserProfile({
    userId,
    ...(userName ? { userName } : {}),
    facts: [...fresh, ...(current?.facts ?? [])].slice(0, MAX_FACTS),
  });
  return fresh.length;
}

/** Replace the whole fact list. Entries may be strings or `{text, timestamp}`. */
export function setFacts(userId: string, facts: unknown): UserFact[] {
  const normalized = normalizeFacts(JSON.stringify(Array.isArray(facts) ? facts : [])).facts;
  upsertUserProfile({ userId, facts: normalized.slice(0, MAX_FACTS) });
  return getUserProfile(userId)?.facts ?? [];
}

/** Delete one fact by exact (case-insensitive) text. Returns how many rows were removed. */
export function removeFact(userId: string, text: string): number {
  const current = getUserProfile(userId);
  if (!current) return 0;
  const needle = text.trim().toLowerCase();
  const kept = current.facts.filter((fact) => fact.text.toLowerCase() !== needle);
  const removed = current.facts.length - kept.length;
  if (removed) upsertUserProfile({ userId, facts: kept });
  return removed;
}

/** Every user, for admin/inspection output. */
export function listUserProfiles(limit = 100): UserProfile[] {
  const rows = db.query(`${SELECT} ORDER BY xp DESC, user_name ASC LIMIT ?`).all(limit) as Parameters<typeof hydrate>[0][];
  return rows.map(hydrate);
}

/** `bond` plus its Thai label, for prompt blocks. */
export function bondDescription(profile: Pick<UserProfile, "bond"> | null | undefined): string {
  if (!profile) return "ไม่มีข้อมูลความสัมพันธ์";
  return `${bondLabel(profile.bond)} (${profile.bond}, ระดับ ${bondLevel(profile.bond)})`;
}
