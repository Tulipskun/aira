import {
  EmbedBuilder,
  type Client,
  type Message,
  type MessageCreateOptions,
  type ReplyOptions,
} from "discord.js";
import { processMessage, type ProcessMessageResult, type TurnSpeaker } from "../pipeline/pipeline.js";
import type { ScheduledMessage } from "../pipeline/scheduler.js";
import { fetchEmotionImage } from "./images.js";
import { buildFooterText, type UserStatus } from "./embed-footer.js";
import { mediaSourcesOf } from "./media.js";
import { sessionKeyFor } from "../sql/sessions.js";
import { isUserSession } from "../session-keys.js";
import { getResponseChannelId } from "./discord-config.js";
import { addRpsComponents, newRpsGameId, registerRpsGame } from "./rps.js";

export function displayNameOf(message: Message): string {
  // member.displayName = guild nickname ?? user.displayName; user.displayName = global name ?? username.
  // member is populated from the MESSAGE_CREATE payload, so no extra GuildMembers intent is needed.
  return message.member?.displayName || message.author.displayName || message.author.username;
}

/** What the model is told when a turn carries media but no words at all. */
export const MEDIA_ONLY_TEXT = "(ไม่มีข้อความแนบมา)";

export function textForModel(message: Message): string {
  return message.cleanContent ?? message.content ?? "";
}

export function toScheduledMessage(message: Message): ScheduledMessage | null {
  const text = textForModel(message).trim();
  const media = mediaSourcesOf(message);
  if (!text && !media.length) return null;

  return {
    userId: message.author.id,
    user: displayNameOf(message),
    text,
    timestamp: new Date(message.createdTimestamp).toISOString(),
    fileName: message.attachments.first()?.name ?? undefined,
    channelId: message.channelId,
    messageId: message.id,
    sessionKey: sessionKeyFor(message.author.id, message.channelId),
    ...(media.length && { media }),
  };
}

export function replyReference(messageId?: string): { reply: ReplyOptions } | Record<string, never> {
  return messageId ? { reply: { messageReference: messageId, failIfNotExists: false } } : {};
}

export function enqueueScheduledMessage(
  scheduler: { interruptOtherSessions: (sessionKey: string) => void; push: (message: ScheduledMessage) => void },
  message: ScheduledMessage,
  typing?: { poke: () => void },
): void {
  scheduler.interruptOtherSessions(message.sessionKey);
  scheduler.push(message);
  typing?.poke();
}

export function replyAnchorOf(messages: ScheduledMessage[]): string | undefined {
  if (!messages.length) return undefined;
  const last = messages[messages.length - 1];
  return messages.every((message) => message.sessionKey === messages[0].sessionKey) ? last.messageId : undefined;
}

export type FlushBusyListener = (busy: boolean) => void;
export type TypingControl = {
  pause: () => Promise<void>;
  resume: () => void;
};

export function createOnFlush(
  client: Client,
  onBusy: FlushBusyListener = () => {},
  typing?: TypingControl,
) {
  return async (messages: ScheduledMessage[]): Promise<void> => {
    if (!messages.length) return;

    const responseChannelId = getResponseChannelId();
    if (!responseChannelId) return;
    if (messages[0].channelId !== responseChannelId) return;

    const mediaSources = messages.flatMap((message) => message.media ?? []);
    const input = messages
      .map((message) => `${message.user}: ${message.text || (message.media?.length ? MEDIA_ONLY_TEXT : "")}`)
      .join("\n");

    const first = messages[0];
    const last = messages[messages.length - 1];
    const speakers: TurnSpeaker[] = [];
    for (const message of messages) {
      if (!speakers.some((speaker) => speaker.userId === message.userId)) {
        speakers.push({ userId: message.userId, user: message.user });
      }
    }
    const anchor = replyAnchorOf(messages);
    let typingPaused = false;
    const pauseTyping = async (): Promise<void> => {
      if (!typing || typingPaused) return;
      await typing.pause();
      typingPaused = true;
    };

    onBusy(true);
    try {
      let result: ProcessMessageResult;
      try {
        result = await processMessage({
          userId: last.userId,
          user: last.user,
          text: input,
          timestamp: first.timestamp,
          fileName: first.fileName,
          mediaSources,
          sessionKey: first.sessionKey,
          speakers,
        });
      } catch (error) {
        console.error(`[PIPELINE] processMessage failed for ${first.userId}: ${String((error as Error)?.stack ?? error)}`);
        await pauseTyping();
        await sendFailureNotice(client, responseChannelId, anchor);
        return;
      }

      const channel = await client.channels.fetch(responseChannelId);
      if (!channel || !channel.isTextBased() || !("send" in channel)) return;

      const imageBuffer = await fetchEmotionImage(result.image);
      if (result.image && !imageBuffer) {
        console.warn(`[DISCORD] ${last.user}: select_image "${result.image}" produced no bytes -- embed sent without a picture`);
      }

      try {
        await pauseTyping();
        let replyPayload = buildReplyPayload({
            text: result.text,
            ...(imageBuffer && result.image ? { image: { buffer: imageBuffer, name: result.image } } : {}),
            ...(result.mood ? { mood: result.mood } : {}),
            ...(result.color !== undefined ? { color: result.color } : {}),
            status: result.status,
            replyTo: anchor,
            privateSession: isUserSession(first.sessionKey),
          });
        if (result.rps) {
          const gameId = crypto.randomUUID();
          replyPayload = addRpsComponents(replyPayload, gameId);
          const sent = await channel.send(replyPayload);
          await registerRpsGame(sent, gameId, first.sessionKey, last.userId, last.user, result.rps);
          const echoed = sent.reference?.messageId;
          const embedColor = result.color === undefined ? "none" : `#${result.color.toString(16).padStart(6, "0")}`;
          console.log(`[DISCORD] ${last.user}: reply sent with RPS=${result.rps}, asked=${anchor ?? "none"}, echoed=${echoed ?? "none"}, mood=${result.mood ?? "none"}, color=${embedColor}, image=${result.image ?? "none"}, session=${first.sessionKey}`);
        } else {
          const sent = await channel.send(replyPayload);
          const echoed = sent.reference?.messageId;
          const embedColor = result.color === undefined ? "none" : `#${result.color.toString(16).padStart(6, "0")}`;
          console.log(
            `[DISCORD] ${last.user}: reply sent, asked=${anchor ?? "none"}, echoed=${echoed ?? "none"}, mood=${result.mood ?? "none"}, color=${embedColor}, image=${result.image ?? "none"}, session=${first.sessionKey}, footer=${JSON.stringify(buildFooterText({ ...result.status, mood: result.mood, privateSession: isUserSession(first.sessionKey) }))}`,
          );
        }
      } catch (error) {
        console.error(`[DISCORD] Failed to send reply: ${String((error as Error)?.message ?? error)}`);
      }
    } finally {
      onBusy(false);
      if (typingPaused) typing?.resume();
    }
  };
}

export function buildReplyPayload(options: {
  text: string;
  image?: { buffer: Buffer; name: string };
  mood?: string;
  color?: number;
  status?: UserStatus;
  replyTo?: string;
  /** True for the private `user:<id>` session; global/group sessions leave the relationship emoji unchanged. */
  privateSession?: boolean;
  timestamp?: Date | string | number;
}): MessageCreateOptions {
  const embed = new EmbedBuilder()
    .setDescription(options.text || "…")
    .setFooter({ text: buildFooterText({ ...options.status, mood: options.mood, privateSession: options.privateSession }) });

  const stamp = options.timestamp === undefined ? new Date() : new Date(options.timestamp);
  if (stamp.getTime() > 0) embed.setTimestamp(stamp);

  if (options.color !== undefined) embed.setColor(options.color);
  if (options.image) embed.setImage(`attachment://${options.image.name}`);

  return {
    embeds: [embed],
    ...replyReference(options.replyTo),
    ...(options.image ? { files: [{ attachment: options.image.buffer, name: options.image.name }] } : {}),
  };
}

async function sendFailureNotice(client: Client, channelId: string, replyTo?: string): Promise<void> {
  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel || !channel.isTextBased() || !("send" in channel)) return;
    await channel.send({
      content: "ขออภัยค่ะ... ไอลาประมวลผลข้อความนี้ไม่สำเร็จ กรุณาลองใหม่อีกครั้งนะคะ",
      ...replyReference(replyTo),
    });
  } catch (error) {
    console.error(`[DISCORD] Failed to send failure notice: ${String((error as Error)?.message ?? error)}`);
  }
}
