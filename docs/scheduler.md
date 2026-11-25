# Message scheduler

The scheduler holds a queue per session key. Incoming messages in the same session are batched after a 5-second quiet period. The maximum wait is 12 seconds from the first message in the batch, preventing a continuously active channel from delaying a response forever.

A message marked immediate flushes the existing batch and itself. Activity in another session flushes that session's pending messages. On process shutdown, queued batches are flushed and active background tasks are drained for a bounded period.

Session keys are `group:<Discord channel id>`. All users in the same Discord channel share one queue and conversation session; different channels remain isolated.
