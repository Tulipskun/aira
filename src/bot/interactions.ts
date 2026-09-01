import {
  ApplicationCommandOptionType,
  MessageFlags,
  type ChatInputCommandInteraction,
} from "discord.js";
import {
  groupChannelOf,
  groupMembership,
  groupMembers,
  joinGroup,
  leaveGroup,
  sessionKeyFor,
} from "../sql/sessions.js";
import { getResponseChannelId } from "./discord-config.js";

export const ISLA_COMMAND_NAME = "isla";

/** Subcommands the registered slash command offers. Kept in one list so the handler and the
 *  registration script cannot drift apart — see scripts/register-commands.ts. */
export const ISLA_SUBCOMMANDS = {
  joinGroup: "join-group",
  leaveGroup: "leave-group",
  status: "status",
  say: "say",
} as const;

export const ISLA_ARGS_OPTION = "args";

/**
 * The slash-command payload, built from `ISLA_SUBCOMMANDS` so the handler and what Discord offers
 * cannot drift: a subcommand added here appears on the next `bun run scripts/register-commands.ts`,
 * and one added only to the switch below is unreachable.
 *
 * `args` lives **only** under `say`. It used to be a top-level option (`/isla <text>`), and Discord
 * rejects that combination outright — "Sub-command and sub-command group option types are mutually
 * exclusive to all other types" (400, code 50035). So the free-text form had to move.
 *
 * Access settings are deliberately absent: `register-commands.ts` copies whatever is live, so this
 * describes the command's shape, not its permissions.
 */
export function islaCommandPayload() {
  const args = {
    name: ISLA_ARGS_OPTION,
    description: "ข้อความที่ต้องการส่งให้ isla",
    type: ApplicationCommandOptionType.String,
    required: false,
  };
  return {
    name: ISLA_COMMAND_NAME,
    description: "คำสั่ง isla",
    options: [
      {
        name: ISLA_SUBCOMMANDS.joinGroup,
        description: "เข้าร่วมเซสชันรวมของแชแนลนี้: แชร์ประวัติและความทรงจำกับทุกคนที่เข้าร่วมในห้องเดียวกัน",
        type: ApplicationCommandOptionType.Subcommand,
      },
      {
        name: ISLA_SUBCOMMANDS.leaveGroup,
        description: "ออกจากเซสชันรวม กลับไปใช้เซสชันส่วนตัว (ค่าเริ่มต้น)",
        type: ApplicationCommandOptionType.Subcommand,
      },
      {
        name: ISLA_SUBCOMMANDS.status,
        description: "ดูว่าข้อความถัดไปจะเข้าเซสชันไหน และใครอยู่ในเซสชันนั้นบ้าง",
        type: ApplicationCommandOptionType.Subcommand,
      },
      {
        name: ISLA_SUBCOMMANDS.say,
        description: "ส่งข้อความให้ isla รับทราบ (ไม่ป้อนเข้า pipeline)",
        type: ApplicationCommandOptionType.Subcommand,
        options: [args],
      },
    ],
  };
}

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
 *
 * Every branch replies ephemerally for the same reason: a session change is a private routing
 * decision, and announcing "X joined the group session" in the room would tell everyone else what
 * they are about to see — which is precisely the thing a user who opts *out* is relying on.
 */
export async function handleIslaCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const sub = interaction.options.getSubcommand(false);
  const userId = interaction.user.id;

  switch (sub) {
    case ISLA_SUBCOMMANDS.joinGroup:
      return handleJoinGroup(interaction, userId);
    case ISLA_SUBCOMMANDS.leaveGroup:
      return handleLeaveGroup(interaction, userId);
    case ISLA_SUBCOMMANDS.status:
      return handleStatus(interaction, userId);
    default:
      return handleSay(interaction);
  }
}

/**
 * `/isla join-group` — share one conversation stream with everyone else in this channel.
 *
 * The room is the channel the command was used in, taken from the interaction rather than typed by
 * the user: there is no way to join a room you are not standing in, and no id to mistype.
 */
async function handleJoinGroup(interaction: ChatInputCommandInteraction, userId: string): Promise<void> {
  const channelId = interaction.channelId;
  if (!channelId) {
    await reply(interaction, "❌ ใช้ในห้องไม่ได้ (ไม่พบ channel) ครับ");
    return;
  }
  // `status` is decided by the write itself, so the reply cannot disagree with the row.
  const { status, previousChannel } = joinGroup(userId, channelId);

  const lines = [
    status === "already"
      ? `✅ อยู่ในห้องรวมนี้แล้ว — ประวัติรวมกับทุกคนใน <#${channelId}>`
      : `✅ เข้าเซสชันรวมของ <#${channelId}> แล้ว`,
    "",
    "ตั้งแต่นี้ข้อความของเธอจะรวมเป็นบทสนทนากับคนอื่นในห้องเดียวกัน " +
      "(ประวัติ + ความทรงจำที่ดึงมาใช้จะถูกเห็นร่วมกัน)",
  ];
  if (previousChannel) lines.push(`↪️ ย้ายมาจากเซสชันรวมของ <#${previousChannel}>`);
  if (channelId !== getResponseChannelId()) {
    lines.push(`⚠️ ไอลาตอบเฉพาะในแชแนลที่ล็อกไว้ — เขียนในแชแนลนี้เธอยังไม่ถูกอ่านอยู่ดี`);
  }
  await reply(interaction, lines.join("\n"));
}

/** `/isla leave-group` — back to a private session. Idempotent: leaving when private is not an error. */
async function handleLeaveGroup(interaction: ChatInputCommandInteraction, userId: string): Promise<void> {
  const left = leaveGroup(userId);
  const lines = left
    ? [`✅ ออกจากเซสชันรวมของ <#${left.channelId}> แล้ว`, "", "กลับสู่เซสชันส่วนตัว: ประวัติและความทรงจำของเธอแยกจากคนอื่นเหมือนเดิม"]
    : ["ℹ️ เธอไม่ได้อยู่ในเซสชันรวมอยู่แล้ว — ตอนนี้ใช้เซสชันส่วนตัวอยู่"];
  await reply(interaction, lines.join("\n"));
}

/** `/isla status` — what stream the *next* message will land in, and who else shares it. */
async function handleStatus(interaction: ChatInputCommandInteraction, userId: string): Promise<void> {
  const channelId = interaction.channelId;
  const membership = groupMembership(userId);
  // Resolved exactly the way an incoming message resolves it, so the answer is a prediction that
  // cannot drift from the real routing.
  const key = sessionKeyFor(userId, channelId);
  const groupChannel = groupChannelOf(key);

  const lines = [
    `**เซสชันของข้อความถัดไป:** \`${key}\` (${groupChannel ? `รวม — แชแนล <#${groupChannel}>` : "ส่วนตัว"})`,
    membership
      ? `เข้าร่วมเซสชันรวมของ <#${membership.channelId}> ตั้งแต่ ${membership.joinedAt}`
      : "ไม่ได้เข้าร่วมเซสชันรวมของแชแนลใด",
  ];
  if (groupChannel) {
    const others = groupMembers(groupChannel).filter((member) => member.userId !== userId);
    lines.push(`**คนอื่นในเซสชันนี้ (${others.length}):** ${others.map((member) => `<@${member.userId}>`).join(" ") || "ไม่มี"}`);
  }
  if (membership && membership.channelId !== channelId) {
    lines.push(`⚠️ เธอเข้าร่วมไว้ที่แชแนล <#${membership.channelId}> — เขียนในแชแนลนี้จึงยังเป็นเซสชันส่วนตัว (สั่ง join-group ที่นี่ถ้าต้องการรวม)`);
  }
  await reply(interaction, lines.join("\n"));
}

/** `/isla say <text>` — the original behaviour: acknowledge the text, feed nothing to the pipeline. */
async function handleSay(interaction: ChatInputCommandInteraction): Promise<void> {
  const args = interaction.options.getString(ISLA_ARGS_OPTION)?.trim() ?? "";
  const content = args
    ? `✅ ไอลาได้รับคำสั่งแล้ว: ${preview(args)}`
    : "✅ ไอลาได้รับคำสั่งแล้ว";
  await reply(interaction, content);
}

async function reply(interaction: ChatInputCommandInteraction, content: string): Promise<void> {
  await interaction.reply({
    content,
    flags: MessageFlags.Ephemeral,
    // Session replies name channels and users. Without this, `<@id>` in the ephemeral response is
    // still a ping to that person, and `@everyone` in a user-supplied `say` argument would fire.
    allowedMentions: { parse: [] },
  });
}
