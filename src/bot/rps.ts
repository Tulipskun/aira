import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  type ButtonInteraction,
  type Client,
  type Message,
  type MessageCreateOptions,
} from "discord.js";
import type { RpsChoice } from "../gemini/reply-format.js";

export type RpsResult = "win" | "lose" | "draw";

type RpsGame = {
  messageId: string;
  channelId: string;
  sessionKey: string;
  ownerId: string;
  ownerName: string;
  islaChoice: RpsChoice;
  timeout: ReturnType<typeof setTimeout>;
  active: boolean;
};

const games = new Map<string, RpsGame>();
const CHOICES: RpsChoice[] = ["rock", "scissors", "paper"];
const LABELS: Record<RpsChoice, string> = { rock: "ค้อน", paper: "กระดาษ", scissors: "กรรไกร" };
const EMOJIS: Record<RpsChoice, string> = { rock: "✊🏻", paper: "🖐🏻", scissors: "✌🏻" };
let rpsClient: Client | undefined;

export function rpsResult(isla: RpsChoice, user: RpsChoice): RpsResult {
  if (isla === user) return "draw";
  if ((isla === "rock" && user === "scissors") || (isla === "scissors" && user === "paper") || (isla === "paper" && user === "rock")) return "win";
  return "lose";
}

export function rpsOutcomeText(isla: RpsChoice, ownerName: string, user: RpsChoice): string {
  const result = rpsResult(isla, user);
  const label = result === "win" ? "isla ชนะ" : result === "lose" ? `${ownerName} ชนะ` : "เสมอ";
  return `Isla: ${isla} ${ownerName}: ${user} ผลลัพธ์: ${label}`;
}

export function newRpsGameId(): string {
  return crypto.randomUUID();
}

function activeRows(gameId: string): ActionRowBuilder<ButtonBuilder>[] {
  return [new ActionRowBuilder<ButtonBuilder>().addComponents(
    ...CHOICES.map((choice) => new ButtonBuilder()
      .setCustomId(`rps:${gameId}:${choice}`)
      .setEmoji({ name: EMOJIS[choice] })
      .setLabel(LABELS[choice])
      .setStyle(ButtonStyle.Primary)),
  )];
}

export function closedRows(islaChoice: RpsChoice, userChoice: RpsChoice): ActionRowBuilder<ButtonBuilder>[] {
  const islaResult = rpsResult(islaChoice, userChoice);
  const userResult: RpsResult = islaResult === "win" ? "lose" : islaResult === "lose" ? "win" : "draw";
  return [new ActionRowBuilder<ButtonBuilder>().addComponents(
    ...CHOICES.map((choice) => {
      const selected = choice === userChoice;
      const selectedStyle = userResult === "win" ? ButtonStyle.Success : userResult === "lose" ? ButtonStyle.Danger : ButtonStyle.Secondary;
      const button = new ButtonBuilder()
        .setCustomId(`rps:closed:${choice}`)
        .setEmoji({ name: EMOJIS[choice] })
        .setLabel(LABELS[choice])
        .setStyle(selected ? selectedStyle : ButtonStyle.Secondary)
        .setDisabled(true);
      return button;
    }),
  )];
}

export function expiredRows(): ActionRowBuilder<ButtonBuilder>[] {
  return [new ActionRowBuilder<ButtonBuilder>().addComponents(
    ...CHOICES.map((choice) => new ButtonBuilder()
      .setCustomId(`rps:expired:${choice}`)
      .setEmoji({ name: EMOJIS[choice] })
      .setLabel(LABELS[choice])
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true)),
  )];
}

export function addRpsComponents(payload: MessageCreateOptions, gameId: string): MessageCreateOptions {
  return { ...payload, components: activeRows(gameId) };
}

export async function registerRpsGame(
  message: Message,
  gameId: string,
  sessionKey: string,
  ownerId: string,
  ownerName: string,
  islaChoice: RpsChoice,
): Promise<void> {
  const timeout = setTimeout(() => { void expireRpsGame(gameId); }, 30_000);
  timeout.unref?.();
  games.set(gameId, { messageId: message.id, channelId: message.channelId, sessionKey, ownerId, ownerName, islaChoice, timeout, active: true });
  bindRpsClient(message.client);
}

async function expireRpsGame(gameId: string): Promise<void> {
  const game = games.get(gameId);
  if (!game || !game.active) return;
  game.active = false;
  games.delete(gameId);
  try {
    if (!rpsClient) return;
    const channel = await rpsClient.channels.fetch(game.channelId);
    if (!channel || !channel.isTextBased() || !("messages" in channel)) return;
    const target = await channel.messages.fetch(game.messageId);
    await target.edit({ components: expiredRows() });
    console.log(`[RPS] expired owner=${game.ownerId} message=${game.messageId}`);
  } catch (error) {
    console.warn(`[RPS] timeout cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function bindRpsClient(client: Client): void {
  rpsClient = client;
}

export type RpsInteractionSink = (input: {
  userId: string;
  user: string;
  text: string;
  timestamp: string;
  sessionKey: string;
  messageId: string;
  immediate: true;
}) => void;

export function handleRpsButton(client: Client, injectMessage: RpsInteractionSink) {
  bindRpsClient(client);
  return async (interaction: ButtonInteraction): Promise<boolean> => {
    const parts = interaction.customId.split(":");
    if (parts[0] !== "rps" || parts.length !== 3) return false;
    const [, gameId, rawChoice] = parts;
    if (!gameId || !(CHOICES as string[]).includes(rawChoice)) return false;
    const game = games.get(gameId);
    if (!game || !game.active) {
      await interaction.reply({ content: "เกมนี้หมดอายุแล้ว", flags: MessageFlags.Ephemeral });
      return true;
    }
    if (interaction.user.id !== game.ownerId) {
      await interaction.reply({ content: "คุณไม่ใช่เจ้าของ session นี้", flags: MessageFlags.Ephemeral });
      return true;
    }
    const userChoice = rawChoice as RpsChoice;
    const result = rpsResult(game.islaChoice, userChoice);
    const outcome = rpsOutcomeText(game.islaChoice, game.ownerName, userChoice);
    game.active = false;
    clearTimeout(game.timeout);
    games.delete(gameId);
    await interaction.update({ components: closedRows(game.islaChoice, userChoice) });
    console.log(`[RPS] injecting interaction immediately into message queue: ${game.ownerName} session=${game.sessionKey}`);
    injectMessage({ userId: game.ownerId, user: game.ownerName, text: `[RPS] ${outcome}`, timestamp: new Date().toISOString(), sessionKey: game.sessionKey, messageId: game.messageId, immediate: true });
    console.log(`[RPS] ${game.ownerName}: Isla=${game.islaChoice} user=${userChoice} result=${result} message=${game.messageId}`);
    return true;
  };
}
