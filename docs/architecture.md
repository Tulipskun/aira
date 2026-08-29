# Architecture

## Flow

```text
Discord
  -> bot.ts
  -> command filter / MessageScheduler
  -> pipeline.ts
  -> Gemini 1
  -> Discord response
  -> Gemini 2 (background)
  -> SQL / Chroma
```

## Identity

- Discord `userId` is the stable internal identity.
- Username is display/context data and may change.
- Discord user IDs are not sent to Gemini.
- File content is not stored in history; only the filename is stored.

## Commands

Messages beginning with `!` are ignored unless the command is registered. Registered commands are handled separately from the AI pipeline.
