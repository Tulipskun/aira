import { MessageFlags, type ChatInputCommandInteraction } from "discord.js";

export const ISLA_COMMAND_NAME = "isla";
const ISLA_ARGS_OPTION = "args";
const PREVIEW_MAX = 200;

// The user's own text is echoed back inside the reply, so flatten newlines and neutralise
// backticks to keep it from breaking out of the message's markdown. Mention pings are blocked
// separately via allowedMentions.
function preview(text: string): string {
  const flat = text.replace(/[\r\n]+/g, " ").replace(/`/g, "'").trim();
  return flat.length > PREVIEW_MAX ? `${flat.slice(0, PREVIEW_MAX - 1)}…` : flat;
}

/**
 * Acknowledge /isla with an ephemeral message: only the invoking user can see it.
 * Uses `flags: MessageFlags.Ephemeral` (the `ephemeral: true` shortcut is deprecated in v14).
 */
export async function handleIslaCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const args = interaction.options.getString(ISLA_ARGS_OPTION)?.trim() ?? "";
  const content = args
    ? `✅ ไอลาได้รับคำสั่งแล้ว: ${preview(args)}`
    : "✅ ไอลาได้รับคำสั่งแล้ว";

  await interaction.reply({
    content,
    flags: MessageFlags.Ephemeral,
    allowedMentions: { parse: [] },
  });
}
