/**
 * Session scope: which conversation stream a message, a history row, or a memory belongs to.
 *
 * Two shapes, and only two:
 *
 * - `user:<userId>` — the default. One private stream per Discord user: their own history window,
 *   their own memories. Nobody else's messages or recalled facts ever enter their context.
 * - `group:<channelId>` — opt-in via `/isla join-group`. Everyone who joined *that channel* shares
 *   one stream, which is how the bot behaved before this existed (history was one global
 *   `getHistory(50)` over every user).
 *
 * The key is stored on every history row and every memory, so scoping is a property of the data,
 * not of a lookup that could change underneath it: if somebody leaves the group mid-conversation,
 * the turns they wrote while inside stay where they belong and simply stop being read.
 *
 * This module is deliberately dependency-free — the key format is needed by the SQLite layer
 * (`sql/sessions.ts`, `sql/history.ts`) *and* by the vector store (`memory/chroma.ts`), and neither
 * should have to import the other to name a session.
 */
export type SessionKey = string;

export const USER_PREFIX = "user:";
export const GROUP_PREFIX = "group:";

/**
 * Where a pre-scoping row goes when no author can be determined.
 *
 * Nothing is ever read from this key, so an unattributable legacy row is filed away rather than
 * handed to whichever user happens to ask next.
 */
export const LEGACY_SESSION_KEY = "legacy:unattributed";

export function userSessionKey(userId: string): SessionKey {
  return `${USER_PREFIX}${userId}`;
}

export function groupSessionKey(channelId: string): SessionKey {
  return `${GROUP_PREFIX}${channelId}`;
}

export function isGroupSession(key: SessionKey): boolean {
  return key.startsWith(GROUP_PREFIX);
}

export function isUserSession(key: SessionKey): boolean {
  return key.startsWith(USER_PREFIX);
}

/** The channel id a group key was built from, or null for a private session. */
export function groupChannelOf(key: SessionKey): string | null {
  return key.startsWith(GROUP_PREFIX) ? key.slice(GROUP_PREFIX.length) : null;
}

/** The owner id a private key was built from, or null for a group session. */
export function userOfSession(key: SessionKey): string | null {
  return key.startsWith(USER_PREFIX) ? key.slice(USER_PREFIX.length) : null;
}
