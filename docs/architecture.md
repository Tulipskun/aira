# Architecture

## Main flow

```text
Discord
  -> bot.ts
  -> command filter + channel lock
  -> MessageScheduler
  -> pipeline.ts
  -> Embedding 2
  -> Chroma memory search
  -> SQL history + relationship
  -> Gemini 1
  -> Gemini 2 (must wait for Gemini 1)
  -> forced execute parser
  -> SQL relationship/stats
  -> select_image(filename)
  -> local images/<filename>
  -> final Discord response + image
```

Gemini 2 is part of the response path. The bot does not reply until Gemini 2 has returned because relationship/state changes and `select_image` may be required to build the final response.

Only work that is not required for the current response may run afterward, such as embedding and persisting newly ingested long-term memory.

## Multi-user input

The scheduler batches messages per Discord `userId`. The pipeline receives the batch as normal application data and formats author names/timestamps for Gemini. Discord IDs remain internal and are never sent to Gemini.

## Data stores

- SQLite: conversation history, relationship, XP, affinity and structured state.
- Chroma: long-term memory vectors.
- Local `images/`: bundled emotion assets.
- `data/discord-config.json`: persistent Discord channel configuration.

## Image flow

`select_image` returns a filename, not a URL. `images.ts` validates it against the bundled image registry and resolves `./images/<filename>`. No runtime fetch from the legacy repository is used.

## Commands and channel lock

Messages beginning with `!` never enter the AI pipeline. Registered commands are owner-only.

- `!islacomehere`: locks the AI channel to the current Discord channel.
- `!unset`: removes the channel lock.

The channel lock persists across restart. Normal messages from other channels are ignored.
