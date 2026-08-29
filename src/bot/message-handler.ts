import { EmbedBuilder, type Client, type Message } from "discord.js";
import { processMessage } from "../pipeline/pipeline.js";
import type { ScheduledMessage } from "../pipeline/scheduler.js";
import { fetchEmotionImage } from "./images.js";
import { getResponseChannelId } from "./discord-config.js";

export function displayNameOf(message: Message): string {
  // member.displayName = guild nickname ?? user.displayName; user.displayName = global name ?? username.
  // member is populated from the MESSAGE_CREATE payload, so no extra GuildMembers intent is needed.
  return message.member?.displayName || message.author.displayName || message.author.username;
}

export function toScheduledMessage(message: Message): ScheduledMessage | null {
  const text = message.content.trim();
  if (!text) return null;

  return {
    userId: message.author.id,
    user: displayNameOf(message),
    text,
    timestamp: new Date(message.createdTimestamp).toISOString(),
    fileName: message.attachments.first()?.name ?? undefined,
    channelId: message.channelId,
  };
}

export function createOnFlush(client: Client) {
  return async (messages: ScheduledMessage[]): Promise<void> => {
    if (!messages.length) return;

    const responseChannelId = getResponseChannelId();
    if (!responseChannelId) return;
    if (messages[0].channelId !== responseChannelId) return;

    const input = messages.reduce(
      (text, message) => (text ? `${text}\n${message.user}: ${message.text}` : `${message.user}: ${message.text}`),
      "",
    );

    const first = messages[0];
    const result = await processMessage({
      userId: first.userId,
      user: first.user,
      text: input,
      timestamp: first.timestamp,
      fileName: first.fileName,
    });

    const channel = await client.channels.fetch(responseChannelId);
    if (!channel || !channel.isTextBased() || !("send" in channel)) return;

    const image = await fetchEmotionImage(result.image);
    const embed = new EmbedBuilder()
      .setDescription(result.text)
      .setFooter({ text: "Isla" });

    if (image && result.image) {
      embed.setImage(`attachment://${result.image}`);
    }

    await channel.send({
      embeds: [embed],
      ...(image && result.image ? { files: [{ attachment: image, name: result.image }] } : {}),
    });
  };
}
