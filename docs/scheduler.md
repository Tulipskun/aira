# Message Scheduler

The scheduler batches messages independently per **session** — by default one private stream per
Discord user, optionally one shared stream per room (see `src/session-keys.ts`).

## Timing

- First message starts a 5-second debounce window.
- Another message **in the same session** is appended to the same batch and resets the 5-second debounce.
- A batch is flushed after the session has been silent for 5 seconds.
- A batch is force-flushed at 12 seconds from the first message, even if it keeps receiving messages.
- A message from a *different* session interrupts the pending batch and causes it to flush immediately.
- Each session has independent pending state/timers.

Example (two private sessions, the default):

```text
12:00:00 Yuuta: ไอล่า
12:00:02 Yuuta: กินข้าวยัง
12:00:04 Farris: วันนี้เป็นไงบ้าง

Yuuta -> flush immediately at 12:00:04
Farris -> starts a new 5-second window
```

Example (one shared session — both users ran `/isla join-group` in this channel):

```text
12:00:00 Alice: ไอล่า
12:00:02 Bob: หวัดดีครับ
12:00:07 (debounce expires)

-> ONE batch, ONE reply, quoted to Bob's message (the last one of the batch)
```

## What a batch is keyed on

`ScheduledMessage.sessionKey`: `user:<id>` (private) or `group:<channel>` (shared). It is resolved
once at receive time by `src/sql/sessions.ts`, so a join or leave in the middle of a debounce window
cannot move messages that were already queued.

Because batching follows the session rather than the user, `interruptByOtherUser` became
`interruptOtherSessions`: in a shared room a second speaker must not cut off the turn that is about
to answer the first one — their messages are merging into the same batch.

Each scheduled message retains `userId`, username, timestamp, text, optional filename, channel ID
and session key so the flushed batch can be routed back to Discord correctly.

`flushAll()` is used for shutdown handling.
