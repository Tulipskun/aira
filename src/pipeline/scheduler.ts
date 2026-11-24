import type { MediaSource } from "../bot/media.js";

export type ScheduledMessage = {
  userId: string;
  user: string;
  text: string;
  timestamp: string;
  fileName?: string;
  channelId: string;
  sessionKey: string;
  messageId?: string;
  media?: MediaSource[];
  immediate?: boolean;
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

  push(message: ScheduledMessage): void {
    const now = Date.now();
    const key = message.sessionKey;
    if (message.immediate) {
      const pending = this.pending.get(key);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(key);
        void this.onFlush([...pending.messages, message]);
      } else {
        void this.onFlush([message]);
      }
      return;
    }
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

  interruptOtherSessions(sessionKey: string): void {
    for (const pendingKey of this.pending.keys()) {
      if (pendingKey !== sessionKey) this.flush(pendingKey);
    }
  }

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

  hasPending(): boolean {
    return this.pending.size > 0;
  }

  pendingCount(): number {
    return this.pending.size;
  }

  private delay(firstAt: number, now: number): number {
    const sinceFirst = now - firstAt;
    return Math.max(0, Math.min(this.debounceMs, this.maxWaitMs - sinceFirst));
  }
}
