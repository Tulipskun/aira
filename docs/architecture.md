# Architecture

## Flow

```text
Discord
  -> bot.ts
  -> command filter / MessageScheduler
  -> pipeline.ts
  -> Embedding 2
  -> Chroma search
  -> SQL relationship
  -> Gemini 1
  -> Gemini 2 (wait for Gemini 1)
  -> execute parser
  -> SQL relationship/stats
  -> select_image(filename)
  -> image filename registry
  -> fetch legacy emotion asset
  -> final Discord response + image
  -> background memory embedding/write to Chroma
```

Gemini 2 is part of the response path because its relationship/state result and selected emotion image are required before replying to the user. Only work that is not required for the current response, such as long-term memory embedding/write, may run after the response.

## Emotion images

`select_image` returns a filename. `images.ts` validates that filename against the known emotion-image registry and resolves it to the corresponding asset in the legacy `AI-roleplay-chat/images` repository. The bot fetches the asset and sends it as a Discord attachment.

The image filename is not treated as an arbitrary URL, so Gemini cannot make the bot fetch an unrelated resource.

## Identity

- Discord `userId` is the stable internal identity.
- Username is display/context data and may change.
- Discord user IDs are not sent to Gemini.
- File content is not stored in history; only the filename is stored.

## Commands

Messages beginning with `!` are ignored unless the command is registered. Registered commands are handled separately from the AI pipeline.
