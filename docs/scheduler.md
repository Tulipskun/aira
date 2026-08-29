# Message Scheduler

The scheduler batches messages independently per Discord `userId`.

## Timing

- First message starts a 5-second debounce window.
- Another message from the same user is appended to the same batch and resets the 5-second debounce.
- A batch is flushed after the user has been silent for 5 seconds.
- A batch is force-flushed at 12 seconds from the first message, even if the user keeps sending messages.
- A message from another user interrupts the pending batch and causes it to flush immediately.
- Each user has independent pending state/timers.

Example:

```text
12:00:00 Yuuta: ไอล่า
12:00:02 Yuuta: กินข้าวยัง
12:00:04 Farris: วันนี้เป็นไงบ้าง

Yuuta -> flush immediately at 12:00:04
Farris -> starts a new 5-second window
```

The scheduler is per user, not per channel. Each scheduled message retains `userId`, username, timestamp, text, optional filename and channel ID so the flushed batch can be routed back to Discord correctly.

`flushAll()` is used for shutdown handling.
