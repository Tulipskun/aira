import { ctxWindowCreate, fakeToolCallResult, sendRequestGemini, type GeminiRequest } from "../gemini/client.js";
import { prepareMedia, type MediaSource } from "../bot/media.js";
import { ISLA_REPLY_SCHEMA, parseIslaReply } from "../gemini/reply-format.js";
import {
  AFFINITY_MAX,
  AFFINITY_MIN,
  AFFINITY_NEUTRAL_FLOOR,
  affinityScaleText,
  FACTS_PER_TURN,
  ISLA_STATE_SCHEMA,
  NO_IMAGE,
  parseIslaState,
  requiredFieldsFor,
  romanticallyAvailable,
  type IslaState,
} from "../gemini/state-format.js";
import { currentTimeBlock, thaiTimestamp } from "../gemini/time.js";
import { addresseeName, DEFAULT_ADDRESSEE, fillPartner, fillPartnerIn } from "../gemini/addressee.js";
import { imageListForPrompt } from "../bot/images.js";
import type { UserStatus } from "../bot/embed-footer.js";
import { embed } from "../memory/embedding.js";
import { isDuplicateMemory, recallMemories, saveMemoryVector } from "../memory/chroma.js";
import { buildRecentEpisode, episodePromptMemory, recallEpisodes, saveEpisode } from "../memory/episodic.js";
import { getHistory, saveMessage, type HistoryMessage } from "../sql/history.js";
import { isGroupSession } from "../sql/sessions.js";
import {
  addFacts,
  addNicknames,
  applyTurnState,
  APPROVAL_NAMES,
  bondDescription,
  getUserProfile,
  upsertUserProfile,
  type UserProfile,
} from "../sql/profile.js";
import {
  BOND_LEVELS,
  bondLabel,
  bondLadderWithThresholds,
  bondLevel,
  bondRecoveryFrom,
  FLIRT_REQUIREMENT,
  PROPOSAL_XP,
  XP_THRESHOLDS,
  xpBandsText,
} from "../sql/bonds.js";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { config } from "../config.js";
import { loadPromptTemplate, renderPrompt, type CachedPrompt, type PromptValues } from "../gemini/prompt-template.js";
import type { Interactions } from "@google/genai";

const PROJECT_ROOT = join(import.meta.dirname, "..", "..");
const FLIRT_XP_BONUS = 25;
export type IncomingMessage = {
  userId: string;
  user: string;
  text: string;
  timestamp: string;
  fileName?: string;
  mediaSources?: MediaSource[];
  sessionKey: string;
  speakers?: TurnSpeaker[];
};
export type ProcessMessageResult = {
  text: string;
  image?: string;
  mood?: string;
  color?: number;
  status: UserStatus;
};
const systemPromptTemplate = readFileSync(join(PROJECT_ROOT, config.paths.gemini1SystemPrompt), "utf8").trim();

export function gemini1SystemPrompt(partner?: string | null): string {
  return fillPartner(systemPromptTemplate, partner);
}

export function gemini2PromptValues(partner?: string | null): PromptValues {
  const who = addresseeName(partner);
  return {
    affinity_min: AFFINITY_MIN,
    affinity_max: AFFINITY_MAX,
    affinity_floor: AFFINITY_NEUTRAL_FLOOR,
    affinity_tiers: affinityScaleText(),
    no_image: NO_IMAGE,
    facts_per_turn: FACTS_PER_TURN,
    bond_ladder: bondLadderWithThresholds(who),
    flirt_requirement: FLIRT_REQUIREMENT,
    proposal_xp: PROPOSAL_XP,
    enemy_xp: XP_THRESHOLDS[-1],
    recovery_bond: bondRecoveryFrom("enemy") ?? "friend",
    capped_level: BOND_LEVELS.sibling.maxLevel ?? BOND_LEVELS.sibling.level,
    expression_images: imageListForPrompt(),
  };
}

const gemini2PromptCache: { current?: CachedPrompt } = {
  current: loadPromptTemplate(
    resolve(PROJECT_ROOT, config.paths.gemini2SystemPrompt),
    "GEMINI2_SYSTEM_PROMPT_FILE",
  ),
};

export function gemini2SystemPrompt(partner?: string | null): string {
  const file = resolve(PROJECT_ROOT, config.paths.gemini2SystemPrompt);
  gemini2PromptCache.current = loadPromptTemplate(file, "GEMINI2_SYSTEM_PROMPT_FILE", gemini2PromptCache.current);
  return renderPrompt(fillPartner(gemini2PromptCache.current.text, partner), gemini2PromptValues(partner), "gemini2");
}

export function profileBlock(profile: UserProfile | null, currentName?: string): string {
  const name = profile?.userName || currentName || "ไม่ทราบชื่อ";
  const nicknames = profile?.nickname.length ? profile.nickname.join(", ") : "-";
  const facts = profile?.facts.length
    ? profile.facts.map((fact) => `- ${fact.timestamp ? `[${thaiTimestamp(fact.timestamp)}] ` : ""}${fact.text}`).join("\n")
    : "- ไม่มี";
  return [
    "<user_profile>",
    `ชื่อ: ${name}`,
    `ความสัมพันธ์กับ Isla: ${bondDescription(profile)}`,
    `ความใกล้ชิดสะสม (xp): ${profile?.xp ?? 0}`,
    `ฉายาที่ Isla ตั้งให้: ${nicknames}`,
    `fact:`,
    facts,
    `หมายเหตุ: ตัวเลขความสัมพันธ์เป็นข้อมูลภายใน อย่านำไปพูดกับ ${name} และอย่าแปลงเป็นคำพูดตรงตัว`,
    `</user_profile>`,
  ].join("\n");
}

export type TurnIdentity = { userId: string; userName: string; profile: UserProfile | null };

export function identityBlockFor(identities: TurnIdentity[], group: boolean, ownerId: string | null = null): string {
  if (!group) {
    const only = identities[0];
    return profileBlock(only?.profile ?? null, only?.userName);
  }
  const blocks = identities.map((identity) => {
    const head = identity.userId === ownerId
      ? `--- คนที่เธอกำลังตอบในเทิร์นนี้ (id: ${identity.userId}) ---`
      : `--- อีกคนในห้องเดียวกัน (id: ${identity.userId}) ---`;
    return `${head}\n${profileBlock(identity.profile, identity.userName)}`;
  });
  return [
    "<group_session>",
    `เซสชันนี้เป็นการสนทนารวม: ทุกคนที่เข้าร่วมผ่าน /isla join-group ในแชแนลนี้ใช้ประวัติและความทรงจำชุดเดียวกัน`,
    `ข้อความในเทิร์นนี้มาจากหลายคน แต่ละบรรทัดขึ้นต้นด้วยชื่อคนพูด — ตอบให้ถูกคน และห้ามอ้างคำพูดของคนหนึ่งเป็นของคนอื่น`,
    `ข้อมูลของแต่ละคนแยกกันเด็ดขาด: fact, ฉายา และระดับความสัมพันธ์ในบล็อกหนึ่งเป็นของคนชื่อนั้นเท่านั้น`,
    ...blocks,
    `</group_session>`,
  ].join("\n");
}

export function turnTranscript(speakers: TurnSpeaker[], text: string): string {
  const breakAt = text.indexOf("\n");
  const firstLine = breakAt === -1 ? text : text.slice(0, breakAt);
  if (speakers.some((speaker) => firstLine.startsWith(`${speaker.user}: `))) return text;
  const only = speakers[speakers.length - 1];
  return `${only?.user ?? DEFAULT_ADDRESSEE}: ${text}`;
}

export function stateBlock(profile: UserProfile | null): string {
  const bond = profile?.bond ?? "stranger";
  const pending = APPROVAL_NAMES.filter((name) => profile?.approvals[name]);
  const lines = [
    "<current_state>",
    `bond: ${bond} (${bondLabel(bond)}, ระดับ ${bondLevel(bond)})`,
    `xp: ${profile?.xp ?? 0}`,
    `flirt_count: ${profile?.flirtCount ?? 0} (ต้องได้อย่างน้อย ${FLIRT_REQUIREMENT} ครั้งจึงจะเป็น crush ได้)`,
    `flirt_xp_bonus: +${FLIRT_XP_BONUS} xp เมื่อ is_flirt=true`,
    `approved_pending: ${pending.length ? pending.join(", ") : "-"}`,
    `xp ที่ต้องมีก่อนเลื่อนระดับจากการตอบตกลง: ${PROPOSAL_XP}`,
    `ขอบเขต xp: ${xpBandsText()}`,
    `ฟิลด์ที่จำเป็นต้องตอบในเทิร์นนี้: ${requiredFieldsFor(bond).join(", ")}`,
    romanticallyAvailable(bond)
      ? `ระดับนี้พัฒนาเป็นเชิงชู้สาวได้ — ตอบ is_flirt ด้วย`
      : `ระดับนี้ไม่สามารถพัฒนาเป็นเชิงชู้สาวได้ — ไม่ต้องส่ง is_flirt`,
    `</current_state>`,
  ];
  return lines.join("\n");
}

export type TurnApplyResult = {
  image?: string;
  status: UserStatus;
};

export async function applyState(
  state: IslaState,
  userId: string,
  timestamp: string,
  userName: string,
  _sessionKey?: string,
): Promise<TurnApplyResult> {
  const result = applyTurnState({
    userId,
    userName,
    affinity: state.affinity + (state.isFlirt === true ? FLIRT_XP_BONUS : 0),
    isFlirt: state.isFlirt,
    approvals: {
      lover: state.approveLover === true,
      soulmate: state.approveSoulmate === true,
      sibling: state.approveSibling === true,
      family: state.approveFamily === true,
    },
  });

  if (result.derivation.changed) {
    console.log(`[PIPELINE] ${userId}: bond ${result.before} -> ${result.after} (${result.derivation.reason})`);
  }

  if (state.addFacts.length) {
    const added = addFacts(userId, state.addFacts, timestamp, userName);
    if (added) console.log(`[PIPELINE] ${userId}: +${added} fact(s)`);
  }

  if (state.addNicknames.length) {
    const added = addNicknames(userId, state.addNicknames, userName);
    if (added) console.log(`[PIPELINE] ${userId}: +${added} nickname(s)`);
  }

  const after = getUserProfile(userId) ?? result.profile;
  return {
    ...(state.selectImage ? { image: state.selectImage } : {}),
    status: {
      userName: after?.userName ?? userName,
      bond: after?.bond ?? result.after,
      xp: after?.xp ?? result.xp,
      xpDelta: state.affinity + (state.isFlirt === true ? FLIRT_XP_BONUS : 0),
      flirtDelta: result.flirtDelta,
      bondUnlocked: result.bondUnlocked,
      nickname: after?.nickname ?? [],
    },
  };
}

export async function ingestMemoryBackground(
  text: string | undefined,
  userId: string,
  eventTimestamp: string,
  sessionKey: string,
): Promise<void> {
  if (!text?.trim()) return;
  try {
    const vector = await embed(text, "document");
    const twin = await isDuplicateMemory(vector, sessionKey);
    if (twin) {
      console.log(`[MEMORY] ${userId}: skipped duplicate "${twin.text.slice(0, 40)}" (${(twin.score ?? 0).toFixed(2)})`);
      return;
    }
    const createdAt = new Date().toISOString();
    await saveMemoryVector({
      id: crypto.randomUUID(),
      text,
      userId,
      timestamp: eventTimestamp,
      sessionKey,
      metadata: { eventTimestamp, createdAt },
    }, vector);
  } catch (error) {
    console.warn(`[MEMORY] ${userId}: background ingestion failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function persistEpisodeBackground(sessionKey: string): Promise<void> {
  try {
    const episode = await buildRecentEpisode(sessionKey);
    if (episode) await saveEpisode(episode);
  } catch (error) {
    console.warn(`[MEMORY] ${sessionKey}: background episode ingestion failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function runGemini2(
  message: IncomingMessage,
  responseText: string,
  summery: string,
  profile: UserProfile | null,
  media: Interactions.Content[],
  speakers: TurnSpeaker[],
  owner: TurnSpeaker,
): Promise<IslaState> {
  const analysisInput = [
    turnTranscript(speakers, message.text),
    `Isla: ${responseText}`,
    ...(summery ? [`(สรุปของข้อความนี้: ${summery})`] : []),
    ``,
    `สถานะด้านล่างคือของ ${owner.user} (id: ${owner.userId}) — ผู้พูดคนสุดท้ายของเทิร์นนี้`,
    stateBlock(profile),
  ].join("\n");
  const request: GeminiRequest = {
    messages: [{ role: "user", userId: message.userId, user: message.user, text: analysisInput, timestamp: new Date().toISOString(), ...(media.length && { media }) }],
  };
  const result = await sendRequestGemini(request, {
    stage: "gemini2",
    systemInstruction: gemini2SystemPrompt(owner.user),
    responseFormat: { type: "text", mime_type: "application/json", schema: fillPartnerIn(ISLA_STATE_SCHEMA, owner.user) },
    debug: { userId: message.userId, userName: message.user },
  });
  const state = parseIslaState(typeof result === "string" ? result : "", profile?.bond ?? "stranger");
  for (const warning of state.warnings) console.warn(`[PIPELINE] ${message.userId}: gemini2 ${warning}`);
  return state;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function restateHistory(history: HistoryMessage[], speakers: Map<string, string>): HistoryMessage[] {
  return history.map((entry) => {
    if (entry.role !== "user") return entry;
    const current = entry.userId ? speakers.get(entry.userId) : undefined;
    if (!current) return entry;
    const stale = entry.user;
    if (!stale || stale === current) return { ...entry, user: current };
    const text = entry.text.replace(new RegExp(`^${escapeRegExp(stale)}: `, "gm"), `${current}: `);
    return { ...entry, user: current, text };
  });
}

export type TurnSpeaker = { userId: string; user: string };

export function turnOwner(speakers: TurnSpeaker[]): TurnSpeaker | null {
  return speakers.length ? speakers[speakers.length - 1]! : null;
}

export async function processMessage(message: IncomingMessage): Promise<ProcessMessageResult> {
  let mark = Date.now();
  const lap = (): number => {
    const now = Date.now();
    const ms = now - mark;
    mark = now;
    return ms;
  };

  const sessionKey = message.sessionKey;
  const group = isGroupSession(sessionKey);
  const speakers: TurnSpeaker[] = message.speakers?.length ? message.speakers : [{ userId: message.userId, user: message.user }];
  const owner = turnOwner(speakers) ?? { userId: message.userId, user: message.user };

  const history = restateHistory(getHistory(50, sessionKey), new Map(speakers.map((speaker) => [speaker.userId, speaker.user])));
  const media = await prepareMedia(message.mediaSources ?? []);
  const fileName = media.summary || message.fileName;
  if (media.parts.length) console.log(`[MEDIA] ${message.user}: ${media.parts.length} part(s) attached — ${media.summary}`);
  saveMessage({ role: "user", userId: message.userId, user: message.user, text: message.text, timestamp: message.timestamp, fileName, sessionKey });
  const prepMs = lap();
  const embedText = message.text || media.summary || "(no text)";
  const vector = await embed(embedText, "query");
  const embedMs = lap();
  const memories = await recallMemories(vector, sessionKey);
  const episodes = await recallEpisodes(vector, sessionKey, message.text);
  const chromaMs = lap();
  const identities = speakers.map((speaker) => {
    let profile = getUserProfile(speaker.userId);
    if (!profile || profile.userName !== speaker.user) {
      profile = upsertUserProfile({ userId: speaker.userId, userName: speaker.user }) ?? profile;
    }
    return { userId: speaker.userId, userName: speaker.user, profile };
  });
  const profile = identities.find((identity) => identity.userId === owner.userId)?.profile ?? null;
  const identityBlock = identityBlockFor(identities, group, owner.userId);
  const temporaryMemory = fakeToolCallResult("search_memory", { user: message.user }, {
    memories: [
      ...memories.map((memory) => ({
        text: memory.text,
        timestamp: thaiTimestamp(memory.timestamp),
        relevance: Number((memory.score ?? 1).toFixed(2)),
        type: "semantic",
      })),
      ...episodes.map(episodePromptMemory),
    ],
  });
  const request1 = ctxWindowCreate(history, message.text, message.user, message.timestamp, fileName, temporaryMemory, message.userId, media.parts);
  const buildMs = lap();
  const response1 = await sendRequestGemini(request1, {
    systemInstruction: `${gemini1SystemPrompt(owner.user)}\n\n${identityBlock}\n\n${currentTimeBlock()}`,
    responseFormat: { type: "text", mime_type: "application/json", schema: fillPartnerIn(ISLA_REPLY_SCHEMA, owner.user) },
    debug: { userId: message.userId, userName: message.user },
  });
  const gemini1Ms = lap();
  const reply = parseIslaReply(typeof response1 === "string" ? response1 : "");
  if (!reply.parsed) {
    console.warn(`[PIPELINE] ${message.user}: Gemini 1 reply was not valid JSON -- sent raw text, no summery/mood/color`);
  } else if (reply.color === undefined) {
    console.warn(`[PIPELINE] ${message.user}: gemini1 sent unusable color "${reply.colorText}" -- embed left default`);
  }
  const responseText = reply.isla;
  const responseTimestamp = new Date().toISOString();
  saveMessage({ role: "model", text: responseText, summary: reply.summery || null, timestamp: responseTimestamp, sessionKey });

  if (reply.summery) void persistEpisodeBackground(sessionKey);

  const state = await runGemini2(message, responseText, reply.summery, profile, media.parts, speakers, owner);
  const gemini2Ms = lap();
  const applied = await applyState(state, owner.userId, message.timestamp, owner.user, sessionKey);
  const applyMs = lap();

  void ingestMemoryBackground(state.ingestMemory, owner.userId, message.timestamp, sessionKey);

  console.log(`[PIPELINE] ${message.user}: total=${prepMs + embedMs + chromaMs + buildMs + gemini1Ms + gemini2Ms + applyMs}ms prep=${prepMs} embed=${embedMs} chroma=${chromaMs} build=${buildMs} gemini1=${gemini1Ms} gemini2=${gemini2Ms} apply=${applyMs}`);
  return {
    text: responseText,
    ...(applied.image ? { image: applied.image } : {}),
    ...(reply.mood && { mood: reply.mood }),
    ...(reply.color !== undefined && { color: reply.color }),
    status: applied.status,
  };
}
