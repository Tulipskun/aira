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
  if (message.author.id !== ownerId) return;

  switch (commandName(message.content)) {
    case "islacomehere":
      await setResponseChannelId(message.channelId);
      await message.reply("Locked to this channel.");
      return;
    case "unset":
      await unsetResponseChannelId();
      await message.reply("Channel lock removed.");
      return;
  }
}
