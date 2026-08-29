import { EmbedBuilder, type Client, type Message } from "discord.js";
import { processMessage, type ProcessMessageResult } from "../pipeline/pipeline.js";
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

export type FlushBusyListener = (busy: boolean) => void;

export function createOnFlush(client: Client, onBusy: FlushBusyListener = () => {}) {
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
    // From here the pipeline runs (tens of seconds) and the reply is then assembled and
    // sent, so the indicator must stay lit through all of it. `finally` guarantees the
    // busy flag is released exactly once, even on unexpected throws — otherwise the
    // in-flight counter in bot.ts would leak and "typing" would never stop.
    onBusy(true);
    try {
      let result: ProcessMessageResult;
      try {
        result = await processMessage({
          userId: first.userId,
          user: first.user,
          text: input,
          timestamp: first.timestamp,
          fileName: first.fileName,
        });
      } catch (error) {
        // The scheduler calls onFlush without awaiting it, so an escaping rejection would
        // surface as an unhandled rejection and take the whole bot (and Chroma) down.
        console.error(`[PIPELINE] processMessage failed for ${first.userId}: ${String((error as Error)?.stack ?? error)}`);
        await sendFailureNotice(client, responseChannelId);
        return;
      }

      const channel = await client.channels.fetch(responseChannelId);
      if (!channel || !channel.isTextBased() || !("send" in channel)) return;

      const image = await fetchEmotionImage(result.image);
      const embed = new EmbedBuilder()
        .setDescription(result.text)
        .setFooter({ text: "Isla" });

      if (image && result.image) {
        embed.setImage(`attachment://${result.image}`);
      }

      try {
        await channel.send({
          embeds: [embed],
          ...(image && result.image ? { files: [{ attachment: image, name: result.image }] } : {}),
        });
      } catch (error) {
        console.error(`[DISCORD] Failed to send reply: ${String((error as Error)?.message ?? error)}`);
      }
    } finally {
      onBusy(false);
    }
  };
}

async function sendFailureNotice(client: Client, channelId: string): Promise<void> {
  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel || !channel.isTextBased() || !("send" in channel)) return;
    await channel.send("ขออภัยค่ะ... ไอลาประมวลผลข้อความนี้ไม่สำเร็จ กรุณาลองใหม่อีกครั้งนะคะ");
  } catch (error) {
    console.error(`[DISCORD] Failed to send failure notice: ${String((error as Error)?.message ?? error)}`);
  }
}
