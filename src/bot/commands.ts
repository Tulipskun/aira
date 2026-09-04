import type { Message } from "discord.js";
import { setResponseChannelId, unsetResponseChannelId } from "./discord-config.js";

export const VALID_COMMANDS = new Set(["islacomehere", "unset"]);

export function commandName(text: string): string {
  return text.slice(1).trim().split(/\s+/, 1)[0]?.toLowerCase() ?? "";
}

export function isKnownCommand(text: string): boolean {
  return VALID_COMMANDS.has(commandName(text));
}

export async function handleCommand(message: Message, ownerId: string): Promise<void> {
  const name = commandName(message.content);
  if (message.author.id !== ownerId) {
    console.warn(`[DISCORD] Command ignored: ${name || "unknown"} (owner authorization failed)`);
    return;
  }

  console.log(`[DISCORD] Owner command accepted: ${name}`);
  switch (name) {
    case "islacomehere":
      await setResponseChannelId(message.channelId);
      await message.reply("Locked to this channel.");
      console.log(`[DISCORD] Response channel locked: ${message.channelId}`);
      return;
    case "unset":
      await unsetResponseChannelId();
      await message.reply("Channel lock removed.");
      console.log("[DISCORD] Response channel unlocked");
      return;
  }
}
