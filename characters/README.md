# Characters

Each `.json` file in this directory registers one character. Isla is the default character and must remain enabled.

Example definition:

```json
{
  "id": "luna",
  "name": "Luna",
  "aliases": ["ลูน่า"],
  "promptFile": "prompts/luna.md",
  "enabled": true
}
```

Create the prompt at `characters/prompts/luna.md`. The prompt defines that character's personality, voice, background and boundaries. Use a unique lowercase `id`; aliases must not overlap other characters.

## Hybrid behavior

- Isla always responds through her existing relationship-aware pipeline.
- The router may invite at most one additional character for each user turn.
- Mentioning a character by name or alias forces that character into the turn.
- The selected character sees the shared Discord conversation history.
- Non-Isla character memories are stored under a character-specific Chroma session key and cannot be recalled by another character.
- Each non-Isla character has a separate SQLite relationship record per Discord user; Isla keeps her existing relationship system.
- Bot-authored messages are ignored by the Discord gateway, preventing character replies from recursively triggering another round.

New character files are loaded at process startup; restart the bot after adding or changing a definition.
