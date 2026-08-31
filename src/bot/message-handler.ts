import {
  EmbedBuilder,
  type Client,
  type Message,
  type MessageCreateOptions,
  type ReplyOptions,
} from "discord.js";
import { processMessage, type ProcessMessageResult } from "../pipeline/pipeline.js";
import type { ScheduledMessage } from "../pipeline/scheduler.js";
import { fetchEmotionImage } from "./images.js";
import { buildFooterText, type UserStatus } from "./embed-footer.js";
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
    messageId: message.id,
    ...(media.length && { media }),
  };
}

/**
 * `reply` in discord.js v14 takes `messageReference`, not the plain `messageId` other libraries
 * use — the wrong key sends the message with no reference and no error, so it fails silently.
 *
 * `failIfNotExists: false` matters here: the pipeline runs for tens of seconds before this send,
 * and if the user deleted their message meanwhile we want a plain message, not a 400.
 */
export function replyReference(messageId?: string): { reply: ReplyOptions } | Record<string, never> {
  return messageId ? { reply: { messageReference: messageId, failIfNotExists: false } } : {};
}

/**
 * Which message of a flushed batch to reply to.
 *
 * The scheduler merges everything a user sent inside the debounce window (5s, capped at 12s) into
 * ONE turn, so a reply would otherwise point at the oldest message while the newest, most relevant
 * one sits unquoted. We anchor on the last message — but only when it belongs to the same author as
 * the turn, because `processMessage()` is given a single user's merged text and quoting somebody
 * else's message would attribute it wrongly.
 */
export function replyAnchorOf(messages: ScheduledMessage[]): string | undefined {
  if (!messages.length) return undefined;
  const last = messages[messages.length - 1];
  return last.userId === messages[0].userId ? last.messageId : undefined;
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
    // Everything the user sent inside the debounce window became ONE turn, so the reply is
    // anchored on their LAST message — see replyAnchorOf().
    const anchor = replyAnchorOf(messages);
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
        await sendFailureNotice(client, responseChannelId, anchor);
        return;
      }

      const channel = await client.channels.fetch(responseChannelId);
      if (!channel || !channel.isTextBased() || !("send" in channel)) return;

      const imageBuffer = await fetchEmotionImage(result.image);
      if (result.image && !imageBuffer) {
        // Gemini 2 named a picture we could not attach. The reply still goes out — but say so,
        // because a missing image is otherwise indistinguishable from her choosing none.
        console.warn(`[DISCORD] ${first.user}: select_image "${result.image}" produced no bytes -- embed sent without a picture`);
      }

      try {
        const sent = await channel.send(
          buildReplyPayload({
            text: result.text,
            ...(imageBuffer && result.image ? { image: { buffer: imageBuffer, name: result.image } } : {}),
            ...(result.mood ? { mood: result.mood } : {}),
            ...(result.color !== undefined ? { color: result.color } : {}),
            status: result.status,
            replyTo: anchor,
          }),
        );
        // Discord REST (fetching the message back) is Cloudflare-blocked from this host, so the log is
        // the only proof a quote went out. `sent.reference` is what the API echoed back in the
        // MESSAGE response — `quote=none` or a mismatch means it landed as a plain message, which is
        // exactly the silent failure replyReference() exists to avoid.
        const echoed = sent.reference?.messageId;
        // `mood`/`color` are what she actually painted the embed with. `color=none` means she sent
        // no usable hex (see the [PIPELINE] warn) and the bar stayed Discord grey.
        const embedColor = result.color === undefined ? "none" : `#${result.color.toString(16).padStart(6, "0")}`;
        // `image=` is what the model picked vs what actually shipped — a name on the left with no
        // attachment is a catalog mismatch, not her opting out. `footer=` is the rendered card, so
        // "the footer looks wrong in Discord" is answerable from the log without re-running a turn.
        // It is a debug aid only: no test asserts this line, and the footer itself is covered by
        // test-profile.ts §11 and test-mood-e2e.ts.
        console.log(
          `[DISCORD] ${first.user}: reply sent, asked=${anchor ?? "none"}, echoed=${echoed ?? "none"}, mood=${result.mood ?? "none"}, color=${embedColor}, image=${result.image ?? "none"}, footer=${JSON.stringify(buildFooterText({ ...result.status, mood: result.mood }))}`,
        );
      } catch (error) {
        console.error(`[DISCORD] Failed to send reply: ${String((error as Error)?.message ?? error)}`);
      }
    } finally {
      onBusy(false);
    }
  };
}

/**
 * The exact object handed to `channel.send()`. Split out so tests can assert the reply reference
 * really is keyed `messageReference` and survives the other spreads — importing `createOnFlush`
 * would otherwise pull in the pipeline (Gemini keys, Chroma, SQLite).
 */
export function buildReplyPayload(options: {
  text: string;
  image?: { buffer: Buffer; name: string };
  /** Isla's mood in Thai -- second line of the embed footer. */
  mood?: string;
  /** 24-bit RGB accent colour for the embed bar. */
  color?: number;
  /** The relationship card -- first line of the footer. Absent (a turn with no profile) leaves the
   * footer as mood-only, or the plain fallback when there is no mood either. */
  status?: UserStatus;
  replyTo?: string;
  /**
   * The moment this reply refers to. Defaults to *now* — deliberately not the incoming message's
   * timestamp: the pipeline runs for tens of seconds, and Discord draws `timestamp` as "today at
   * HH:MM" on the reply itself, so an old timestamp would claim the answer arrived before it did.
   */
  timestamp?: Date | string | number;
}): MessageCreateOptions {
  // Discord rejects an embed whose description is empty (it surfaced as "Missing
  // Permissions" in the log). A media-only turn can legitimately produce a text-free reply.
  const embed = new EmbedBuilder()
    .setDescription(options.text || "…")
    .setFooter({ text: buildFooterText({ ...options.status, mood: options.mood }) });

  // setTimestamp() takes a Date or an epoch number only (a *string* is rejected by the builder's
  // validator even when it is a valid ISO date), so normalise here. Anything unparseable — and
  // epoch 0, which is what a missing/legacy timestamp decays to — is dropped rather than costing
  // the reply or stamping it with 1970.
  const stamp = options.timestamp === undefined ? new Date() : new Date(options.timestamp);
  if (stamp.getTime() > 0) embed.setTimestamp(stamp);

  // setColor() takes a 24-bit integer only (a hex *string* is rejected by the builder's
  // validator), and an absent colour falls back to Discord's default grey.
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
