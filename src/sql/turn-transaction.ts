import { Database } from "bun:sqlite";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import { deriveBond, isBond, isBondUnlock, type ApprovalName, type BondDerivation, type BondLevel } from "./bonds.js";
import { getUserProfile, MAX_FACTS, MAX_NICKNAMES, type UserProfile } from "./profile.js";

const path = process.env.SQLITE_PATH ?? "./.aira/aira.db";
mkdirSync(dirname(path), { recursive: true });
const db = new Database(path, { create: true });
db.run("PRAGMA busy_timeout = 5000");

db.run(`CREATE TABLE IF NOT EXISTS turn_state_applied (
  session_key TEXT NOT NULL,
  user_id TEXT NOT NULL,
  event_timestamp TEXT NOT NULL,
  applied_at TEXT NOT NULL,
  PRIMARY KEY (session_key, user_id, event_timestamp)
)`);

const APPROVAL_NAMES: ApprovalName[] = ["family", "sibling", "soulmate", "lover"];
const NO_APPROVALS: Record<ApprovalName, boolean> = { family: false, sibling: false, soulmate: false, lover: false };

type Change = {
  userId: string;
  userName?: string;
  affinity: number;
  isFlirt?: boolean;
  approvals?: Partial<Record<ApprovalName, boolean>>;
};

export type AtomicTurnResult = {
  profile: UserProfile | null;
  before: BondLevel;
  after: BondLevel;
  xp: number;
  flirtCount: number;
  flirtDelta: number;
  bondUnlocked: boolean;
  derivation: BondDerivation;
  factsAdded: number;
  nicknamesAdded: number;
  duplicate: boolean;
};

function parseArray(value: unknown): unknown[] {
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function normalizeFacts(value: unknown, timestamp: string) {
  const items = parseArray(value);
  return items.map((item) => {
    if (typeof item === "string") return { text: item.trim(), timestamp };
    if (item && typeof item === "object") {
      const text = typeof (item as { text?: unknown }).text === "string" ? (item as { text: string }).text.trim() : "";
      const ts = typeof (item as { timestamp?: unknown }).timestamp === "string" ? (item as { timestamp: string }).timestamp : "";
      return text ? { text, timestamp: ts } : null;
    }
    return null;
  }).filter((x): x is { text: string; timestamp: string } => !!x);
}

function normalizeStrings(value: unknown): string[] {
  return parseArray(value)
    .filter((x): x is string => typeof x === "string" && !!x.trim())
    .map((x) => x.trim());
}

export function applyTurnStateAtomic(
  change: Change,
  facts: string[],
  nicknames: string[],
  timestamp: string,
  sessionKey: string,
): AtomicTurnResult {
  db.run("BEGIN IMMEDIATE");
  try {
    const existing = db.query(`SELECT 1 AS present FROM turn_state_applied WHERE session_key = ? AND user_id = ? AND event_timestamp = ?`).get(sessionKey, change.userId, timestamp) as { present: number } | null;
    if (existing) {
      db.run("ROLLBACK");
      const profile = getUserProfile(change.userId);
      const bond = profile?.bond ?? "stranger";
      return {
        profile,
        before: bond,
        after: bond,
        xp: profile?.xp ?? 0,
        flirtCount: profile?.flirtCount ?? 0,
        flirtDelta: 0,
        bondUnlocked: false,
        derivation: deriveBond(bond, profile?.xp ?? 0, {
          flirtCount: profile?.flirtCount ?? 0,
          approvals: profile?.approvals ?? NO_APPROVALS,
        }),
        factsAdded: 0,
        nicknamesAdded: 0,
        duplicate: true,
      };
    }

    const row = db.query(`SELECT user_id, user_name, bond, xp, flirt_count, approved_lover, approved_soulmate, approved_sibling, approved_family, facts_json, nickname_json FROM user_profiles WHERE user_id = ?`).get(change.userId) as {
      user_id: string;
      user_name: string;
      bond: string;
      xp: number;
      flirt_count: number;
      approved_lover: number;
      approved_soulmate: number;
      approved_sibling: number;
      approved_family: number;
      facts_json: string;
      nickname_json: string;
    } | null;

    const before = isBond(row?.bond) ? row!.bond : "stranger";
    const userName = change.userName ?? row?.user_name ?? change.userId;
    const xp = (row?.xp ?? 0) + (Number.isFinite(change.affinity) ? Math.trunc(change.affinity) : 0);
    const flirted = change.isFlirt === true;
    const flirtCount = (row?.flirt_count ?? 0) + (flirted ? 1 : 0);
    const approvals: Record<ApprovalName, boolean> = {
      lover: !!row?.approved_lover,
      soulmate: !!row?.approved_soulmate,
      sibling: !!row?.approved_sibling,
      family: !!row?.approved_family,
    };
    for (const name of APPROVAL_NAMES) if (change.approvals?.[name]) approvals[name] = true;

    const derivation = deriveBond(before, xp, { flirtCount, approvals });
    for (const name of derivation.consumed) approvals[name] = false;

    const oldFacts = normalizeFacts(row?.facts_json, timestamp);
    const existingFacts = new Set(oldFacts.map((f) => f.text.toLowerCase()));
    const freshFacts: { text: string; timestamp: string }[] = [];
    for (const fact of facts) {
      const text = typeof fact === "string" ? fact.trim() : "";
      if (!text || existingFacts.has(text.toLowerCase())) continue;
      existingFacts.add(text.toLowerCase());
      freshFacts.push({ text, timestamp });
    }

    const oldNicknames = normalizeStrings(row?.nickname_json);
    const existingNicknames = new Set(oldNicknames.map((n) => n.toLowerCase()));
    const freshNicknames: string[] = [];
    for (const nickname of nicknames) {
      const value = typeof nickname === "string" ? nickname.trim() : "";
      if (!value || existingNicknames.has(value.toLowerCase())) continue;
      existingNicknames.add(value.toLowerCase());
      freshNicknames.push(value);
    }

    db.query(`INSERT INTO user_profiles (user_id, user_name, bond, xp, flirt_count, approved_lover, approved_soulmate, approved_sibling, approved_family, facts_json, nickname_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        user_name=excluded.user_name, bond=excluded.bond, xp=excluded.xp, flirt_count=excluded.flirt_count,
        approved_lover=excluded.approved_lover, approved_soulmate=excluded.approved_soulmate,
        approved_sibling=excluded.approved_sibling, approved_family=excluded.approved_family,
        facts_json=excluded.facts_json, nickname_json=excluded.nickname_json`).run(
      change.userId,
      userName,
      derivation.bond,
      xp,
      flirtCount,
      approvals.lover ? 1 : 0,
      approvals.soulmate ? 1 : 0,
      approvals.sibling ? 1 : 0,
      approvals.family ? 1 : 0,
      JSON.stringify([...freshFacts, ...oldFacts].slice(0, MAX_FACTS)),
      JSON.stringify([...freshNicknames, ...oldNicknames].slice(0, MAX_NICKNAMES)),
    );

    db.query(`INSERT INTO turn_state_applied (session_key, user_id, event_timestamp, applied_at) VALUES (?, ?, ?, ?)`).run(sessionKey, change.userId, timestamp, new Date().toISOString());
    db.run("COMMIT");

    const profile = getUserProfile(change.userId);
    return {
      profile,
      before,
      after: derivation.bond,
      xp,
      flirtCount,
      flirtDelta: flirted ? 1 : 0,
      bondUnlocked: isBondUnlock(before, derivation.bond),
      derivation,
      factsAdded: freshFacts.length,
      nicknamesAdded: freshNicknames.length,
      duplicate: false,
    };
  } catch (error) {
    try { db.run("ROLLBACK"); } catch {}
    throw error;
  }
}
