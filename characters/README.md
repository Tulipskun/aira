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

- A Gemini speaker scheduler may choose silence or any combination of up to two characters. Rem and Bocchi can speak together without Isla; no character is required to answer every user message.
- Mentioning a character by name or alias gives that character priority and requires a response.
- Every selected character sees the shared Discord room history. When two characters are selected, the later speaker sees the first character's newly saved message and may reply to it.
- Every character, including Isla, stores semantic and episodic memories in its own SQLite session namespace; another character cannot retrieve those memories.
- Each character has a separate relationship record per Discord user and a directed relationship view of other characters. A's view of B is not automatically shared with B.
- Bot-authored messages are ignored by the Discord gateway, preventing character replies from recursively triggering another round.

Character definitions are loaded when a turn selects characters. File-based additions and edits therefore apply to subsequent turns without restarting the bot. The Discord Control Panel can also create and edit definitions and prompts while Aira is running.
