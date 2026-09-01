import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { bondLabel, bondLevel, deriveBond, isBond, isBondUnlock, type ApprovalName, type BondDerivation, type BondLevel } from "./bonds.js";

/**
 * One user, one row.
 *
 * This table used to be two: `user_profiles` (name, nicknames, facts) and `relationships`
 * (state, xp, affinity). They were keyed by the same `user_id` and always read together, so they
 * are merged here. `migrateUserProfiles()` moves the old data across and then removes the
 * leftovers; see the notes on each column for what came from where.
 *
 * The numeric stats `trust`, `affection` and `familiarity` are **gone**. They were three numbers the
 * model was asked to move every turn, none of them fed a rule, and `familiarity` never had a writer
 * at all. What remains is the two things the ladder actually consumes: `xp` (how close) and
 * `flirt_count` (how many times the user came on to her and she took it), plus four one-way flags
 * recording proposals she has accepted but the xp gate has not granted yet.
 *
 * `bond` is **derived**, never written directly from a model's request — see `deriveAndSetBond()`.
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
  /** Rung on the ladder in `bonds.ts`. Was `relationships.state`. Derived, never model-set. */
  bond: BondLevel;
  /** Relationship points — what Gemini 2 calls `affinity`. Was `relationships.xp`. */
  xp: number;
  /** Accepted flirtatious approaches, all-time. Gates the `crush` rung. */
  flirtCount: number;
  /**
   * Proposals Isla accepted that are waiting on xp. Cleared when the rung is granted.
   * `lover` only matters at `crush`, `soulmate` only at `lover`; `sibling`/`family` are open doors.
   */
  approvals: Record<ApprovalName, boolean>;
  /** Many facts per user. Was a flat `string[]`. */
  facts: UserFact[];
};

/** Fields a caller may write. `userId` always identifies the row. */
export type UserProfilePatch = Partial<Omit<UserProfile, "userId" | "bond" | "approvals">> & {
  userId: string;
  /** Only `deriveAndSetBond()` should pass this; a model cannot reach it. */
  bond?: BondLevel | string;
  approvals?: Partial<Record<ApprovalName, boolean>>;
};

/** Facts are kept newest-first and capped, because the whole list goes into a prompt every turn. */
export const MAX_FACTS = 40;

/**
 * Nicknames she has given this user. Capped well below the facts: they are shown in the embed
 * footer, and a card with ten tags stops being a card.
 */
export const MAX_NICKNAMES = 8;

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
  ["flirt_count", "INTEGER NOT NULL DEFAULT 0"],
  ["approved_lover", "INTEGER NOT NULL DEFAULT 0"],
  ["approved_soulmate", "INTEGER NOT NULL DEFAULT 0"],
  ["approved_sibling", "INTEGER NOT NULL DEFAULT 0"],
  ["approved_family", "INTEGER NOT NULL DEFAULT 0"],
  ["facts_json", "TEXT NOT NULL DEFAULT '[]'"],
];

/** Columns the simplified model no longer uses. Copied or dropped by the migration. */
const RETIRED_COLUMNS = ["trust", "affection", "familiarity"];

/** The approval flags, in the order the ladder consults them. */
export const APPROVAL_NAMES: ApprovalName[] = ["family", "sibling", "soulmate", "lover"];

/** A fresh row has accepted nothing. */
const NO_APPROVALS: Record<ApprovalName, boolean> = { family: false, sibling: false, soulmate: false, lover: false };

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

  // ---- legacy relationships: state -> bond, xp -> xp ----
  // `affinity` is NOT carried over: it was a second, differently-scaled copy of the same idea as
  // xp, and the simplified model keeps only xp. See the note on `RETIRED_COLUMNS`.
  if (columnsOf("relationships").size > 0) {
    const rel = columnsOf("relationships");
    const select = [
      `user_id`,
      rel.has("user_name") ? `user_name` : `'' AS user_name`,
      rel.has("state") ? `state` : `'stranger' AS state`,
      rel.has("xp") ? `xp` : `0 AS xp`,
    ].join(", ");
    const rows = db.query(`SELECT ${select} FROM relationships`).all() as {
      user_id: string;
      user_name: string | null;
      state: string | null;
      xp: number | null;
    }[];

    // Fill any legacy NOT NULL column the INSERT cannot skip (see legacyRequiredColumns).
    const fillers = legacyRequiredColumns();
    const merge = db.query(`
      INSERT INTO user_profiles (user_id, user_name, bond, xp${fillers.length ? ", " + fillers.map((f) => f.column).join(", ") : ""})
      VALUES (?, ?, ?, ?${fillers.length ? ", " + fillers.map(() => "?").join(", ") : ""})
      ON CONFLICT(user_id) DO UPDATE SET
        user_name = COALESCE(NULLIF(user_profiles.user_name, ''), excluded.user_name),
        bond      = CASE WHEN user_profiles.bond = 'stranger' THEN excluded.bond ELSE user_profiles.bond END,
        xp        = CASE WHEN user_profiles.xp = 0 THEN excluded.xp ELSE user_profiles.xp END
    `);

    for (const row of rows) {
      const bond = isBond(row.state) ? row.state : "stranger";
      const userName = row.user_name ?? row.user_id;
      merge.run(
        row.user_id,
        userName,
        bond,
        Number.isFinite(row.xp) ? Number(row.xp) : 0,
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

  // ---- drop columns the simplified schema no longer uses ----
  if (!keepLegacySchema()) {
    // `affinity`/`affection` are listed too: they were the same idea as xp on a different scale, and
    // keeping one number per relationship is the whole point of the simplification.
    for (const legacy of ["name", "nicknames_json", "affinity", ...RETIRED_COLUMNS]) {
      if (!had.has(legacy) || !now.has(legacy)) continue;
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
  bond, xp, flirt_count AS flirtCount, approved_lover AS approvedLover, approved_soulmate AS approvedSoulmate,
  approved_sibling AS approvedSibling, approved_family AS approvedFamily,
  facts_json AS factsJson FROM user_profiles`;

/**
 * Read a row defensively.
 *
 * `bond` has no CHECK constraint (so a level can be added without ALTER TABLE), facts were once a
 * flat string array, and the approval flags are 0/1 integers that a half-migrated database may not
 * have at all (they read back as `undefined`). Anything unrecognisable degrades to the default
 * rather than throwing in the middle of a reply.
 */
function hydrate(row: {
  userId: string;
  userName: string | null;
  nicknameJson: string | null;
  bond: string | null;
  xp: number | null;
  flirtCount: number | null | undefined;
  approvedLover: number | null | undefined;
  approvedSoulmate: number | null | undefined;
  approvedSibling: number | null | undefined;
  approvedFamily: number | null | undefined;
  factsJson: string | null;
}): UserProfile {
  return {
    userId: row.userId,
    userName: row.userName || row.userId,
    nickname: normalizeStringArray(row.nicknameJson),
    bond: isBond(row.bond) ? row.bond : "stranger",
    xp: Number.isFinite(row.xp) ? Number(row.xp) : 0,
    flirtCount: Number.isFinite(row.flirtCount) ? Number(row.flirtCount) : 0,
    approvals: {
      lover: truthyFlag(row.approvedLover),
      soulmate: truthyFlag(row.approvedSoulmate),
      sibling: truthyFlag(row.approvedSibling),
      family: truthyFlag(row.approvedFamily),
    },
    facts: normalizeFacts(row.factsJson).facts,
  };
}

/** 0/1 (or missing) column to boolean. Anything non-zero counts, so a legacy REAL 1.0 works too. */
function truthyFlag(value: number | null | undefined): boolean {
  return Number.isFinite(value) ? Number(value) !== 0 : false;
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
  if (patch.flirtCount !== undefined) add("flirt_count", Math.max(0, Math.trunc(Number(patch.flirtCount) || 0)));
  if (patch.approvals !== undefined) {
    for (const name of APPROVAL_NAMES) {
      add(`approved_${name}`, patch.approvals[name] ? 1 : 0);
    }
  }
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
 * Apply one turn's state — the only writer of `xp`, `flirt_count`, the approval flags and `bond`.
 *
 * Replaces `adjustProfileStats()` + `setBond()`, which let a caller name a rung directly. Now the
 * model reports what happened and `deriveBond()` decides the rung, so there is exactly one path onto
 * the ladder and it cannot be talked around.
 *
 * Every approval Isla accepted is recorded, even when the xp gate cannot grant the rung yet: she said
 * yes out loud, and forgetting that would contradict her own earlier message. `deriveBond()` clears a
 * flag only when it actually moved the rung (see `consumed`).
 */
export type TurnStateChange = {
  userId: string;
  userName?: string;
  /** Relationship points for this turn, already clamped by the parser (-100..100). */
  affinity: number;
  /** The user flirted and she took it. */
  isFlirt?: boolean;
  approvals?: Partial<Record<ApprovalName, boolean>>;
};

export type TurnStateResult = {
  profile: UserProfile | null;
  before: BondLevel;
  after: BondLevel;
  xp: number;
  flirtCount: number;
  /**
   * Flirts this turn actually added to `flirtCount` — 1 or 0.
   *
   * Reported by the writer rather than read off `change.isFlirt` so the footer's `[Flirt +1]` can
   * only ever appear on a turn that really incremented the counter.
   */
  flirtDelta: number;
  /**
   * True when this turn *reached* a new rung worth announcing (`[Lover Unlocked]`).
   *
   * Narrower than `derivation.changed`, which is also true for a demotion — see `isBondUnlock()`.
   */
  bondUnlocked: boolean;
  derivation: BondDerivation;
};

export function applyTurnState(change: TurnStateChange): TurnStateResult {
  const userId = change.userId;
  const current = getUserProfile(userId);
  const before = current?.bond ?? "stranger";
  const userName = change.userName ?? current?.userName ?? userId;

  const xp = (current?.xp ?? 0) + (Number.isFinite(change.affinity) ? Math.trunc(change.affinity) : 0);
  const flirted = change.isFlirt === true;
  const flirtCount = (current?.flirtCount ?? 0) + (flirted ? 1 : 0);

  // Merge this turn's yeses into the pending ones; nothing is cleared here, only on consumption.
  const approvals: Record<ApprovalName, boolean> = { ...(current?.approvals ?? NO_APPROVALS) };
  for (const name of APPROVAL_NAMES) {
    if (change.approvals?.[name]) approvals[name] = true;
  }

  const derivation = deriveBond(before, xp, { flirtCount, approvals });

  // A granted proposal is no longer pending — otherwise the flag would keep re-firing the rule.
  for (const name of derivation.consumed) approvals[name] = false;

  const profile = upsertUserProfile({
    userId,
    userName,
    xp,
    flirtCount,
    approvals,
    bond: derivation.bond,
  });

  return {
    profile,
    before,
    after: derivation.bond,
    xp,
    flirtCount,
    flirtDelta: flirted ? 1 : 0,
    bondUnlocked: isBondUnlock(before, derivation.bond),
    derivation,
  };
}

/**
 * Set the bond without going through the ladder.
 *
 * Only the owner-facing CLI should call this (and nothing in the reply path does); it exists so a
 * human can fix a relationship without editing SQL.
 */
export function forceBond(userId: string, bond: BondLevel, userName?: string): UserProfile | null {
  if (!isBond(bond)) return null;
  return upsertUserProfile({ userId, bond, ...(userName ? { userName } : {}) });
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

/**
 * Append nicknames Isla gave the user, newest first, dropping duplicates.
 *
 * `nickname_json` existed since the first schema but had **no writer at all** — the column was
 * always `[]`, so the footer's `#tag` slot could never fill. This is that writer; it is called from
 * `applyState()` with whatever Gemini 2 detected in her reply.
 *
 * Returns how many were actually added.
 */
export function addNicknames(userId: string, nicknames: string[], userName?: string): number {
  const incoming = nicknames.map((n) => (typeof n === "string" ? n.trim() : "")).filter(Boolean);
  if (!incoming.length) return 0;
  const current = getUserProfile(userId);
  const existing = new Set((current?.nickname ?? []).map((n) => n.toLowerCase()));
  const fresh: string[] = [];
  for (const nickname of incoming) {
    if (existing.has(nickname.toLowerCase())) continue;
    existing.add(nickname.toLowerCase());
    fresh.push(nickname);
  }
  if (!fresh.length) return 0;
  upsertUserProfile({
    userId,
    ...(userName ? { userName } : {}),
    nickname: [...fresh, ...(current?.nickname ?? [])].slice(0, MAX_NICKNAMES),
  });
  return fresh.length;
}

/** Replace the whole nickname list. */
export function setNicknames(userId: string, nicknames: unknown): string[] {
  const normalized = normalizeStringArray(JSON.stringify(Array.isArray(nicknames) ? nicknames : []));
  upsertUserProfile({ userId, nickname: normalized.slice(0, MAX_NICKNAMES) });
  return getUserProfile(userId)?.nickname ?? [];
}

/** Remove one nickname by exact (case-insensitive) text. Returns how many were removed. */
export function removeNickname(userId: string, nickname: string): number {
  const current = getUserProfile(userId);
  if (!current) return 0;
  const needle = nickname.trim().toLowerCase();
  const kept = current.nickname.filter((n) => n.toLowerCase() !== needle);
  const removed = current.nickname.length - kept.length;
  if (removed) upsertUserProfile({ userId, nickname: kept });
  return removed;
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
