export type ScheduledMessage = {
  userId: string;
  user: string;
  text: string;
  timestamp: string;
  fileName?: string;
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
    const existing = this.pending.get(message.userId);

    if (existing) {
      existing.messages.push(message);
      clearTimeout(existing.timer);
      existing.timer = setTimeout(() => this.flush(message.userId), this.delay(existing.firstAt, now));
      return;
    }

    const pending: Pending = {
      messages: [message],
      firstAt: now,
      timer: setTimeout(() => this.flush(message.userId), this.debounceMs),
    };
    this.pending.set(message.userId, pending);
  }

  interruptByOtherUser(userId: string): void {
    for (const pendingUserId of this.pending.keys()) {
      if (pendingUserId !== userId) this.flush(pendingUserId);
    }
  }

  flush(userId: string): void {
    const pending = this.pending.get(userId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(userId);
    void this.onFlush(pending.messages);
  }

  flushAll(): void {
    for (const userId of this.pending.keys()) this.flush(userId);
  }

  private delay(firstAt: number, now: number): number {
    const sinceFirst = now - firstAt;
    return Math.max(0, Math.min(this.debounceMs, this.maxWaitMs - sinceFirst));
  }
}
