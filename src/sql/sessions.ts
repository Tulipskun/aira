import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  GROUP_PREFIX,
  LEGACY_SESSION_KEY,
  USER_PREFIX,
  groupChannelOf,
  groupSessionKey,
  isGroupSession,
  isUserSession,
  userOfSession,
  userSessionKey,
  type SessionKey,
} from "../session-keys.js";

// Re-exported so callers that think of a session as "the thing in the database" can import the key
// helpers from here, while memory/chroma.ts reaches for ../session-keys.js directly and never pulls
// the SQLite layer along. See that module for what the two key shapes mean.
export {
  GROUP_PREFIX,
  LEGACY_SESSION_KEY,
  USER_PREFIX,
  groupChannelOf,
  groupSessionKey,
  isGroupSession,
  isUserSession,
  userOfSession,
  userSessionKey,
  type SessionKey,
};

/**
 * Membership in a shared ("group") session.
 *
 * Its own table rather than a column on `user_profiles`, because a session is routing, not a fact
 * about the relationship: `/isla join-group` must never be able to touch bond/xp/facts, and the
 * profile migration stays untouched.
 */

// Same file as `messages`, different connection: history.ts owns that handle and its migrations.
// WAL is unnecessary (writes happen only when a slash command is used), but busy_timeout matters —
// the bot and the forget CLI can both hold this file open.
const path = process.env.SQLITE_PATH ?? "./.aira/aira.db";
mkdirSync(dirname(path), { recursive: true });
const db = new Database(path, { create: true });
db.run("PRAGMA busy_timeout = 5000");

db.run(`CREATE TABLE IF NOT EXISTS group_sessions (
  user_id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  joined_at TEXT NOT NULL
)`);
db.run("CREATE INDEX IF NOT EXISTS idx_group_sessions_channel ON group_sessions(channel_id)");

export type GroupMembership = {
  userId: string;
  channelId: string;
  joinedAt: string;
};

const getRow = db.query<
  { user_id: string; channel_id: string; joined_at: string },
  [string]
>(`SELECT user_id, channel_id, joined_at FROM group_sessions WHERE user_id = ?`);

const listByChannel = db.query<
  { user_id: string; channel_id: string; joined_at: string },
  [string]
>(`SELECT user_id, channel_id, joined_at FROM group_sessions WHERE channel_id = ? ORDER BY joined_at ASC`);

const upsertRow = db.prepare(
  `INSERT INTO group_sessions (user_id, channel_id, joined_at) VALUES (?, ?, ?)
   ON CONFLICT(user_id) DO UPDATE SET channel_id = excluded.channel_id, joined_at = excluded.joined_at`,
);

const deleteRow = db.prepare(`DELETE FROM group_sessions WHERE user_id = ?`);

function toMembership(row: { user_id: string; channel_id: string; joined_at: string } | null): GroupMembership | null {
  if (!row) return null;
  return { userId: row.user_id, channelId: row.channel_id, joinedAt: row.joined_at };
}

/** Who this user joined, or null when they are on a private session (the default). */
export function groupMembership(userId: string): GroupMembership | null {
  return toMembership(getRow.get(userId));
}

/**
 * The session a message from `userId` in `channelId` belongs to.
 *
 * Reading the channel from the *incoming message* rather than from the stored row is what makes a
 * stale join harmless: if the user joined in channel A and now writes in channel B, they are not in
 * A's room, so they get their private session. Their membership is left alone — moving to a new
 * channel is `join-group` again, not an accident caused by typing elsewhere.
 */
export function sessionKeyFor(userId: string, channelId: string | null): SessionKey {
  const membership = getRow.get(userId);
  if (channelId && membership && membership.channel_id === channelId) return groupSessionKey(channelId);
  return userSessionKey(userId);
}

export type JoinResult = {
  /**
   * `already` — they were already in this room (a no-op, `joined_at` preserved).
   * `moved`  — they were in a *different* room, now relocated; `previousChannel` says which.
   * `joined` — they were on a private session and are now in a room.
   *
   * A discriminated result rather than a nullable `previous`, because "was private" and "was already
   * here" both have no *other* room to name, and the caller has to distinguish them to say
   * "you're already in this room" instead of "you joined".
   */
  status: "already" | "moved" | "joined";
  current: GroupMembership;
  /** The channel they left behind, only when `status === "moved"`. */
  previousChannel?: string;
};

/**
 * Join (or move to) the group session of `channelId`.
 *
 * Re-joining the room they are already in is not a move: `joined_at` is preserved so `/isla status`
 * keeps reporting when they actually arrived.
 */
export function joinGroup(userId: string, channelId: string): JoinResult {
  const previous = toMembership(getRow.get(userId));
  if (previous && previous.channelId === channelId) return { status: "already", current: previous };
  const current: GroupMembership = { userId, channelId, joinedAt: new Date().toISOString() };
  upsertRow.run(userId, current.channelId, current.joinedAt);
  return previous
    ? { status: "moved", current, previousChannel: previous.channelId }
    : { status: "joined", current };
}

/** Leave whatever group session this user is in. Returns false when they were already private. */
export function leaveGroup(userId: string): GroupMembership | null {
  const previous = toMembership(getRow.get(userId));
  if (!previous) return null;
  deleteRow.run(userId);
  return previous;
}

/** Everyone sharing `channelId`'s group session, oldest join first. */
export function groupMembers(channelId: string): GroupMembership[] {
  return listByChannel.all(channelId).map((row) => ({
    userId: row.user_id,
    channelId: row.channel_id,
    joinedAt: row.joined_at,
  }));
}

/** Ids of every user currently in some group session — used by the forget CLI and diagnostics. */
export function allGroupMembers(): GroupMembership[] {
  return db
    .query<{ user_id: string; channel_id: string; joined_at: string }, []>(
      `SELECT user_id, channel_id, joined_at FROM group_sessions ORDER BY channel_id ASC, joined_at ASC`,
    )
    .all()
    .map((row) => ({ userId: row.user_id, channelId: row.channel_id, joinedAt: row.joined_at }));
}

export function closeSessionsDb(): void {
  db.close();
}
