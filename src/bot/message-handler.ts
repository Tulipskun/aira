import { EmbedBuilder, type Client, type Message } from "discord.js";
import { processMessage, type ProcessMessageResult } from "../pipeline/pipeline.js";
import type { ScheduledMessage } from "../pipeline/scheduler.js";
import { fetchEmotionImage } from "./images.js";
import { mediaSourcesOf } from "./media.js";
import { getResponseChannelId } from "./discord-config.js";

export function displayNameOf(message: Message): string {
  // member.displayName = guild nickname ?? user.displayName; user.displayName = global name ?? username.
  // member is populated from the MESSAGE_CREATE payload, so no extra GuildMembers intent is needed.
  return message.member?.displayName || message.author.displayName || message.author.username;
}

/** What the model is told when a turn carries media but no words at all. */
export const MEDIA_ONLY_TEXT = "(ไม่มีข้อความแนบมา)";

export function toScheduledMessage(message: Message): ScheduledMessage | null {
  const text = message.content.trim();
  // Sources are only URLs — resolving them costs no network, so this stays cheap enough for the
  // receive path. A sticker-only message has empty content but is still worth answering.
  const media = mediaSourcesOf(message);
  if (!text && !media.length) return null;

  return {
    userId: message.author.id,
    user: displayNameOf(message),
    text,
    timestamp: new Date(message.createdTimestamp).toISOString(),
    fileName: message.attachments.first()?.name ?? undefined,
    channelId: message.channelId,
    ...(media.length && { media }),
  };
}

export type FlushBusyListener = (busy: boolean) => void;

export function createOnFlush(client: Client, onBusy: FlushBusyListener = () => {}) {
  return async (messages: ScheduledMessage[]): Promise<void> => {
    if (!messages.length) return;

    const responseChannelId = getResponseChannelId();
    if (!responseChannelId) return;
    if (messages[0].channelId !== responseChannelId) return;

    // Merge the batch into one turn. Media is concatenated in arrival order and capped later
    // by collectMedia, so the first few items of a burst are what the model actually sees.
    const mediaSources = messages.flatMap((message) => message.media ?? []);
    // A message with only media has no words to merge. Naming the attachment is what the turn
    // consists of, so say so instead of leaving "user: " dangling — this text is also what gets
    // embedded, and the embedding endpoint rejects an empty part.
    const input = messages
      .map((message) => `${message.user}: ${message.text || (message.media?.length ? MEDIA_ONLY_TEXT : "")}`)
      .join("\n");

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
          mediaSources,
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
      // Discord rejects an embed whose description is empty (it surfaced as "Missing
      // Permissions" in the log). A media-only turn can legitimately produce a text-free reply.
      const embed = new EmbedBuilder()
        .setDescription(result.text || "…")
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
