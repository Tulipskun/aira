import type { MediaSource } from "../bot/media.js";

export type ScheduledMessage = {
  userId: string;
  user: string;
  text: string;
  timestamp: string;
  fileName?: string;
  channelId: string;
  /**
   * Conversation stream this message belongs to (`user:<id>` / `group:<channel>`), resolved once at
   * receive time by sql/sessions.ts. The scheduler batches on THIS rather than on `userId`, which is
   * what makes a group session one merged turn from several people instead of one turn each.
   */
  sessionKey: string;
  /**
   * Discord message id, used to reply to the *last* message of a flushed batch. Optional so
   * callers that build messages by hand (tests, replays) keep compiling — the reply is simply
   * skipped when it is missing rather than falling back to some earlier message in the batch.
   */
  messageId?: string;
  /**
   * Media URLs referenced by the message (attachments, custom emojis, stickers), captured
   * without touching the network. The bytes are fetched when the batch flushes.
   */
  media?: MediaSource[];
};

export type MessageSchedulerOptions = {
  debounceMs?: number;
  maxWaitMs?: number;
  onFlush: (messages: ScheduledMessage[]) => void | Promise<void>;
};

type Pending = {
  messages: ScheduledMessage[];
  firstAt: number;
  timer: ReturnType<typeof setTimeout>;
};

export class MessageScheduler {
  private readonly debounceMs: number;
  private readonly maxWaitMs: number;
  private readonly onFlush: MessageSchedulerOptions["onFlush"];
  private readonly pending = new Map<string, Pending>();

  constructor(options: MessageSchedulerOptions) {
    this.debounceMs = options.debounceMs ?? 5_000;
    this.maxWaitMs = options.maxWaitMs ?? 12_000;
    this.onFlush = options.onFlush;
  }

  /**
   * Batches are keyed by session, not by user. Two people in the same group session therefore merge
   * into ONE turn that she answers once, while two private sessions never wait on each other.
   */
  push(message: ScheduledMessage): void {
    const now = Date.now();
    const key = message.sessionKey;
    const existing = this.pending.get(key);

    if (existing) {
      existing.messages.push(message);
      clearTimeout(existing.timer);
      existing.timer = setTimeout(() => this.flush(key), this.delay(existing.firstAt, now));
      return;
    }

    const pending: Pending = {
      messages: [message],
      firstAt: now,
      timer: setTimeout(() => this.flush(key), this.debounceMs),
    };
    this.pending.set(key, pending);
  }

  /**
   * Flush every session except `sessionKey`. Called when a new message arrives so a session that is
   * being written to keeps its own turn boundary, and the others answer what they already have.
   */
  interruptOtherSessions(sessionKey: string): void {
    for (const pendingKey of this.pending.keys()) {
      if (pendingKey !== sessionKey) this.flush(pendingKey);
    }
  }

  /**
   * @deprecated use `interruptOtherSessions`. Kept as an alias because callers historically spoke of
   * users; a session key is the same idea now, so this takes a session key, not a user id.
   */
  interruptByOtherUser(sessionKey: string): void {
    this.interruptOtherSessions(sessionKey);
  }

  flush(sessionKey: string): void {
    const pending = this.pending.get(sessionKey);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(sessionKey);
    void this.onFlush(pending.messages);
  }

  flushAll(): void {
    for (const sessionKey of this.pending.keys()) this.flush(sessionKey);
  }

  /** True while at least one session has messages waiting in the debounce queue. */
  hasPending(): boolean {
    return this.pending.size > 0;
  }

  /** Number of sessions with queued messages. */
  pendingCount(): number {
    return this.pending.size;
  }

  private delay(firstAt: number, now: number): number {
    const sinceFirst = now - firstAt;
    return Math.max(0, Math.min(this.debounceMs, this.maxWaitMs - sinceFirst));
  }
}
