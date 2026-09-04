import {
  ApplicationCommandOptionType,
  EmbedBuilder,
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
import { listUserProfiles } from "../sql/profile.js";
import { bondLabel } from "../sql/bonds.js";
import { getResponseChannelId } from "./discord-config.js";

export const ISLA_COMMAND_NAME = "isla";

/** Subcommands offered by the registered slash command. */
export const ISLA_SUBCOMMANDS = {
  joinGroup: "join-group",
  leaveGroup: "leave-group",
  status: "status",
  leaderboard: "leaderboard",
} as const;

export function islaCommandPayload() {
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
        name: ISLA_SUBCOMMANDS.leaderboard,
        description: "ดู 10 อันดับผู้ใช้ที่มี XP สูงสุด",
        type: ApplicationCommandOptionType.Subcommand,
      },
    ],
  };
}

const PREVIEW_MAX = 200;

function preview(text: string): string {
  const flat = text.replace(/[\r\n]+/g, " ").replace(/`/g, "'").trim();
  return flat.length > PREVIEW_MAX ? `${flat.slice(0, PREVIEW_MAX - 1)}…` : flat;
}

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
    case ISLA_SUBCOMMANDS.leaderboard:
      return handleLeaderboard(interaction);
    default:
      return handleStatus(interaction, userId);
  }
}

async function handleJoinGroup(interaction: ChatInputCommandInteraction, userId: string): Promise<void> {
  const channelId = interaction.channelId;
  if (!channelId) {
    await reply(interaction, "❌ ใช้ในห้องไม่ได้ (ไม่พบ channel) ครับ");
    return;
  }
  const { status, previousChannel } = joinGroup(userId, channelId);

  const lines = [
    status === "already"
      ? `✅ อยู่ในห้องรวมนี้แล้ว — ประวัติรวมกับทุกคนใน <#${channelId}>`
      : `✅ เข้าเซสชันรวมของ <#${channelId}> แล้ว`,
    "",
    "ตั้งแต่นี้ข้อความของเธอจะรวมเป็นบทสนทนากับคนอื่นในห้องเดียวกัน (ประวัติ + ความทรงจำที่ดึงมาใช้จะถูกเห็นร่วมกัน)",
  ];
  if (previousChannel) lines.push(`↪️ ย้ายมาจากเซสชันรวมของ <#${previousChannel}>`);
  if (channelId !== getResponseChannelId()) {
    lines.push(`⚠️ ไอลาตอบเฉพาะในแชแนลที่ล็อกไว้ — เขียนในแชแนลนี้เธอยังไม่ถูกอ่านอยู่ดี`);
  }
  await reply(interaction, lines.join("\n"));
}

async function handleLeaveGroup(interaction: ChatInputCommandInteraction, userId: string): Promise<void> {
  const left = leaveGroup(userId);
  const lines = left
    ? [`✅ ออกจากเซสชันรวมของ <#${left.channelId}> แล้ว`, "", "กลับสู่เซสชันส่วนตัว: ประวัติและความทรงจำของเธอแยกจากคนอื่นเหมือนเดิม"]
    : ["ℹ️ เธอไม่ได้อยู่ในเซสชันรวมอยู่แล้ว — ตอนนี้ใช้เซสชันส่วนตัวอยู่"];
  await reply(interaction, lines.join("\n"));
}

async function handleStatus(interaction: ChatInputCommandInteraction, userId: string): Promise<void> {
  const channelId = interaction.channelId;
  const membership = groupMembership(userId);
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

async function handleLeaderboard(interaction: ChatInputCommandInteraction): Promise<void> {
  const profiles = listUserProfiles(10);
  const description = profiles.length
    ? profiles.map((profile, index) => {
        const name = preview(profile.userName || profile.userId);
        return `${index + 1}. **${name}** (${bondLabel(profile.bond)}) ${bondEmoji(profile.bond)} ${profile.xp} [Flirt: ${profile.flirtCount}]`;
      }).join("\n")
    : "ยังไม่มีข้อมูลผู้ใช้";

  const embed = new EmbedBuilder()
    .setTitle("Isla Leaderboard")
    .setDescription(description)
    .setFooter({ text: "จัดอันดับตาม XP" });

  await interaction.reply({ embeds: [embed], allowedMentions: { parse: [] } });
}

function bondEmoji(bond: string): string {
  switch (bond) {
    case "lover":
    case "soulmate":
      return "❤️";
    case "crush":
      return "💗";
    case "close_friend":
      return "💙";
    case "friend":
      return "💛";
    case "sibling":
      return "💚";
    case "family":
      return "🧡";
    case "enemy":
      return "💢";
    default:
      return "";
  }
}

async function reply(interaction: ChatInputCommandInteraction, content: string): Promise<void> {
  await interaction.reply({
    content,
    flags: MessageFlags.Ephemeral,
    allowedMentions: { parse: [] },
  });
}
