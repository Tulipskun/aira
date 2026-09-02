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
import { getHistory, saveMessage, type HistoryMessage } from "../sql/history.js";
import { groupChannelOf, isGroupSession, userOfSession } from "../sql/sessions.js";
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
export type IncomingMessage = {
  userId: string;
  user: string;
  text: string;
  timestamp: string;
  fileName?: string;
  /** Media URLs to fetch and attach to this turn. Fetched once, used by both stages. */
  mediaSources?: MediaSource[];
  /**
   * Which conversation stream this turn belongs to — see sql/sessions.ts. Required: history and
   * memory are both scoped by it, so a turn without one would either read nobody's context or
   * everybody's. `user:<userId>` is the default; `group:<channelId>` when the sender opted in.
   */
  sessionKey: string;
  /**
   * Everyone who spoke inside this turn's debounce batch, in arrival order. A private session has
   * one entry; a group session can carry several people whose messages were merged into one turn.
   * When absent the turn is treated as `userId`/`user` alone.
   */
  speakers?: TurnSpeaker[];
};
export type ProcessMessageResult = {
  text: string;
  /** Expression image filename chosen by Gemini 2, already validated against `images/`. */
  image?: string;
  /** Isla's mood in Thai, from Gemini 1 -- rendered in the embed footer. */
  mood?: string;
  /** That mood as a 24-bit RGB integer -- the embed's accent colour. Undefined when she sent no
   * usable colour, which must not cost us the reply. */
  color?: number;
  /**
   * The relationship card the embed footer is built from: who this user is to her right now, after
   * this turn's xp landed. Read off the row `applyState()` just wrote, so the footer can never
   * disagree with the database.
   */
  status: UserStatus;
};
const systemPromptTemplate = readFileSync(join(PROJECT_ROOT, config.paths.gemini1SystemPrompt), "utf8").trim();

/**
 * Gemini 1's instruction, addressed to whoever this turn belongs to.
 *
 * The file is read once at module load (a prompt edit needs a restart — unlike Gemini 2's, which is
 * re-read by mtime), and it carries `{{partner}}` wherever it would otherwise say "the user". Only
 * the name is substituted per turn; the rest of the prose is byte-stable, so the cached prefix is
 * shared by every turn of one person's conversation.
 */
export function gemini1SystemPrompt(partner?: string | null): string {
  return fillPartner(systemPromptTemplate, partner);
}

/**
 * The numbers Gemini 2's instruction asks for, from the modules that own them.
 *
 * Every value here already exists in code: `AFFINITY_NEUTRAL_FLOOR`, the affinity bands, the ladder
 * and its xp gates, the flirt requirement, and the `images/` directory. The instruction file used to
 * restate them as Thai prose — `+${10}` typed out beside the constant that says 10, "ระดับ 3" written
 * by hand beside `BOND_LEVELS.sibling.level` — and a restated number is one that can drift away from
 * the rule that actually uses it. Changing a threshold in `sql/bonds.ts` now reaches the prompt on
 * its own.
 *
 * Nothing in here is per-turn (see `gemini2SystemPrompt()` for why that matters).
 *
 * `partner` is deliberately NOT one of these values even though the ladder text needs a name: the
 * name is substituted by `fillPartner()` *before* `renderPrompt()` runs, because spacing a name
 * against Thai prose is a rule that must exist in exactly one place (`gemini/addressee.ts`) and
 * `renderPrompt()` knows nothing about it. Two substitution layers each guessing at whitespace is
 * how `เมื่อ Yuuta ขอ` and `เมื่อ ไอล่า ขอ` end up in the same prompt.
 */
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

/** The cache slot for the instruction file. Module-level so the mtime check is per process. */
const gemini2PromptCache: { current?: CachedPrompt } = {
  // Read once at module load, like Gemini 1's prompt: a missing or unreadable instruction file is a
  // broken deploy and should stop the bot at startup, not degrade its first reply.
  current: loadPromptTemplate(
    resolve(PROJECT_ROOT, config.paths.gemini2SystemPrompt),
    "GEMINI2_SYSTEM_PROMPT_FILE",
  ),
};

/**
 * Gemini 2's instruction — the relationship analyst, rendered from `prompts/isla-state.md`.
 *
 * The wording is a file (relocatable with `GEMINI2_SYSTEM_PROMPT_FILE`) exactly like Gemini 1's
 * character prompt, and the numbers in it come from `gemini2PromptValues()` above.
 *
 * It used to answer with an `execute` tool call carrying an `operations` array. It now answers with
 * one flat JSON object like Gemini 1 does, which removes a whole class of failure: the tool path
 * needed a synthetic `thought` signature to be legal, and its `args` schema had to be spelled out
 * field-by-field or the model sent `{}` every time and silently lost the turn.
 *
 * Still deliberately free of anything that changes per *user or turn* (their current numbers): a
 * stable string is what keeps the prompt cache warm, so the per-turn state travels in the message —
 * see `runGemini2()`. The image catalog is in here because it changes only when somebody adds a
 * picture to `images/`, never between turns.
 *
 * Re-read per request but cached by mtime, so editing the file or dropping in a picture takes effect
 * on the next message without a restart. While neither changes *and the same person is being
 * answered*, the returned string is byte-identical across calls, so the cache still works per user.
 *
 * `partner` is the display name of whoever this turn's ladder belongs to. Naming them is what stops
 * the analyst from reading a rule about "the user" as a rule about anybody in the room.
 */
export function gemini2SystemPrompt(partner?: string | null): string {
  const file = resolve(PROJECT_ROOT, config.paths.gemini2SystemPrompt);
  gemini2PromptCache.current = loadPromptTemplate(file, "GEMINI2_SYSTEM_PROMPT_FILE", gemini2PromptCache.current);
  // Name first, numbers second: `fillPartner()` owns how a name sits against Thai prose, and
  // `renderPrompt()` must never see a `{{partner}}` it would have to substitute without that rule.
  return renderPrompt(fillPartner(gemini2PromptCache.current.text, partner), gemini2PromptValues(partner), "gemini2");
}

/**
 * What Gemini 1 is told about the person it is talking to.
 *
 * One block from one table. The numbers here are internal state, not conversation topics — that is
 * why xp is the only one shown: it is the ladder's fuel, and Gemini 1 has no rule that consumes it.
 */
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
    // Named, not "the user": this block is about one specific person and the sentence is a rule
    // about who may hear these numbers. `${name}` is the same name the block is filed under two
    // lines above, so the instruction and its subject cannot drift apart.
    `หมายเหตุ: ตัวเลขความสัมพันธ์เป็นข้อมูลภายใน อย่านำไปพูดกับ ${name} และอย่าแปลงเป็นคำพูดตรงตัว`,
    `</user_profile>`,
  ].join("\n");
}

/** One person's identity material for a turn. */
export type TurnIdentity = { userId: string; userName: string; profile: UserProfile | null };

/**
 * The identity material for a whole turn.
 *
 * A private session has exactly one person, so this is `profileBlock()` unchanged — byte-for-byte,
 * which matters because that block is the stable part of Gemini 1's cached prefix.
 *
 * A group session has everyone who spoke, and Isla needs each of them separately: one block would
 * describe one user while the message contains four, and she would answer the wrong person's
 * history. Two things the wording has to do, both learned from how the text actually arrives:
 *  - name the person she is *answering* (the last speaker, whose ladder this turn moves), or she
 *    will treat the whole room as one addressee;
 *  - say explicitly that facts/nicknames/bonds do not cross between blocks. Sharing one history
 *    stream is the point of the feature, and without this line "we see the same context" reads as
 *    "these facts are about each other".
 */
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

/**
 * The turn as Gemini 2 reads it: who said what.
 *
 * The merged text already carries `Name: ` on every line (see `createOnFlush`), so prefixing it with
 * one more name duplicates it for a private turn and — worse — labels an entire group turn as one
 * person's words, which is exactly the misattribution that then moves the wrong user's ladder.
 * A hand-built turn (tests, replays) has no prefix at all, so the label is added only when the first
 * line is not already attributed to one of this turn's speakers.
 */
export function turnTranscript(speakers: TurnSpeaker[], text: string): string {
  const breakAt = text.indexOf("\n");
  const firstLine = breakAt === -1 ? text : text.slice(0, breakAt);
  // Matched as a prefix, not by splitting on ":": a Discord display name may contain one ("A: B"),
  // and the merged form written by `createOnFlush` is exactly `${name}: ${text}`.
  if (speakers.some((speaker) => firstLine.startsWith(`${speaker.user}: `))) return text;
  const only = speakers[speakers.length - 1];
  // The fallback is a placeholder name, never a generic noun: an unattributed line labelled
  // "ผู้ใช้:" would read to the analyst as a fifth person in the room.
  return `${only?.user ?? DEFAULT_ADDRESSEE}: ${text}`;
}

/**
 * What Gemini 2 is told about the current state.
 *
 * This is the per-turn part, sent in the *message* rather than the system prompt so the cached
 * prefix stays stable. It carries exactly the numbers the ladder consumes — bond, xp, flirt count,
 * pending approvals — plus the fields this user must answer, because requiredness depends on the
 * rung and the JSON schema cannot express that.
 */
export function stateBlock(profile: UserProfile | null): string {
  const bond = profile?.bond ?? "stranger";
  const pending = APPROVAL_NAMES.filter((name) => profile?.approvals[name]);
  const lines = [
    "<current_state>",
    `bond: ${bond} (${bondLabel(bond)}, ระดับ ${bondLevel(bond)})`,
    `xp: ${profile?.xp ?? 0}`,
    `flirt_count: ${profile?.flirtCount ?? 0} (ต้องได้อย่างน้อย ${FLIRT_REQUIREMENT} ครั้งจึงจะเป็น crush ได้)`,
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

/** What one turn's state changed, in the shape the reply path needs. */
export type TurnApplyResult = {
  /** The image to attach, or undefined when the model sent `none` / an unusable name. */
  image?: string;
  /** The relationship card *after* this turn — bond, xp and this turn's delta. */
  status: UserStatus;
};

/**
 * Apply one turn's JSON state.
 *
 * Replaces `applyExecute()`. Order matters: the ladder move (`applyTurnState`) happens first so a
 * fact or memory written later sees the same bond the user was just promoted to.
 *
 * It also returns the resulting card, because the footer must show the numbers *after* this turn's
 * xp landed — reading them separately would race with the write and could show the pre-turn value.
 * Nicknames come from the same row. Nothing writes them yet (she has no tool for it), so the footer
 * simply has no `#tags` until that exists — see the note in `sql/profile.ts`.
 *
 * `userId`/`userName` are whose ladder this turn moves (see `turnOwner()`), not necessarily whoever
 * the batch started with. `sessionKey` is stamped on any memory written here so retrieval can stay
 * inside the session — it is optional only so the ladder contract can be tested without inventing
 * one.
 *
 * Exported so the contract can be tested without a Gemini round-trip.
 */
export async function applyState(
  state: IslaState,
  userId: string,
  timestamp: string,
  userName: string,
  sessionKey?: string,
): Promise<TurnApplyResult> {
  const result = applyTurnState({
    userId,
    userName,
    affinity: state.affinity,
    ...(state.isFlirt !== undefined && { isFlirt: state.isFlirt }),
    approvals: {
      lover: state.approveLover === true,
      soulmate: state.approveSoulmate === true,
      sibling: state.approveSibling === true,
      family: state.approveFamily === true,
    },
  });

  if (result.derivation.changed) {
    console.log(
      `[PIPELINE] ${userId}: bond ${result.before} -> ${result.after} (${result.derivation.reason})`,
    );
  }

  if (state.addFacts.length) {
    const added = addFacts(userId, state.addFacts, timestamp, userName);
    if (added) console.log(`[PIPELINE] ${userId}: +${added} fact(s)`);
  }

  // Nicknames are read out of her own reply — she has no tool for it, and the footer's `#tag` slot
  // was dead until this existed (the column had no writer since the first schema).
  if (state.addNicknames.length) {
    const added = addNicknames(userId, state.addNicknames, userName);
    if (added) console.log(`[PIPELINE] ${userId}: +${added} nickname(s)`);
  }

  if (state.ingestMemory) {
    const vector = await embed(state.ingestMemory);
    // Nothing deduplicated on write before this, so one proposal became two rows inside two minutes
    // (the live collection holds "ฟาริสขอไอล่าแต่งงาน…" twice). Every duplicate spends a slot in the
    // recall window that a distinct memory could have used, so a restatement is dropped instead.
    const twin = await isDuplicateMemory(vector, sessionKey);
    if (twin) {
      console.log(`[PIPELINE] ${userId}: memory skipped as duplicate of "${twin.text.slice(0, 40)}" (${(twin.score ?? 0).toFixed(2)})`);
    } else {
      await saveMemoryVector({ id: crypto.randomUUID(), text: state.ingestMemory, userId, timestamp, sessionKey }, vector);
    }
  }

  // Read the row last: the card must show the nicknames written above, not the ones from before
  // this turn. `result.profile` is the pre-nickname snapshot, so it is only the fallback.
  const after = getUserProfile(userId) ?? result.profile;
  return {
    ...(state.selectImage ? { image: state.selectImage } : {}),
    status: {
      userName: after?.userName ?? userName,
      bond: after?.bond ?? result.after,
      xp: after?.xp ?? result.xp,
      xpDelta: state.affinity,
      // Both badges come from the writer, not from what the model asked for: `[Flirt +1]` only
      // appears if `flirt_count` really moved, and `[X Unlocked]` only if the ladder says the move
      // was a promotion onto an announceable rung (a demotion never is).
      flirtDelta: result.flirtDelta,
      bondUnlocked: result.bondUnlocked,
      nickname: after?.nickname ?? [],
    },
  };
}

/**
 * Gemini 2 — the relationship analyst.
 *
 * Sees the raw user message, Isla's reply, and her own one-line recap (`summery`) from Gemini 1:
 * the recap is the cheapest available summary of what she *meant*, which is what decides whether a
 * proposal was accepted. It is the only place `summery` is ever consumed.
 */
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
    // Not `${message.user}: ${message.text}` — in a group turn that would credit every line of the
    // merged batch to one person. See turnTranscript().
    turnTranscript(speakers, message.text),
    `Isla: ${responseText}`,
    ...(summery ? [`(สรุปของข้อความนี้: ${summery})`] : []),
    ``,
    // Whose ladder this is, stated next to the numbers: the transcript above has several names, and
    // the state block has exactly one.
    `สถานะด้านล่างคือของ ${owner.user} (id: ${owner.userId}) — ผู้พูดคนสุดท้ายของเทิร์นนี้`,
    stateBlock(profile),
  ].join("\n");
  const request: GeminiRequest = {
    // Gemini 2 sees the same media as Gemini 1, otherwise it would be asked to write a memory
    // about a photo it never looked at.
    messages: [{ role: "user", userId: message.userId, user: message.user, text: analysisInput, timestamp: new Date().toISOString(), ...(media.length && { media }) }],
  };
  const result = await sendRequestGemini(request, {
    // Answers as JSON like Gemini 1, so the stage must be stated: `responseMode` no longer tells
    // client.ts which key pool or model this call belongs to.
    stage: "gemini2",
    // Named by the ladder's owner, not "the user": the transcript above can carry four speakers and
    // every field in this JSON means exactly one of them. Same name in the instruction and the
    // schema, so the two cannot describe different people.
    systemInstruction: gemini2SystemPrompt(owner.user),
    responseFormat: { type: "text", mime_type: "application/json", schema: fillPartnerIn(ISLA_STATE_SCHEMA, owner.user) },
    debug: { userId: message.userId, userName: message.user },
  });
  const state = parseIslaState(typeof result === "string" ? result : "", profile?.bond ?? "stranger");
  for (const warning of state.warnings) {
    console.warn(`[PIPELINE] ${message.userId}: gemini2 ${warning}`);
  }
  return state;
}


function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Stored turns carry the name the author used back then, both in user_name and as the
// "name: " prefix the scheduler merges into text. Re-stamp these senders' past turns with their
// current display names so the model sees one consistent identity after a rename. A group session
// shares one stream between several people, hence the map rather than a single id.
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

/** One person who spoke in this turn. */
export type TurnSpeaker = { userId: string; user: string };

/**
 * Whose ladder this turn moves.
 *
 * `applyTurnState()` writes one row and Gemini 2 reports one affinity number, so a group turn has
 * to nominate exactly one owner. It is the speaker of the LAST message of the batch — the same
 * message the reply is quoted to (see `replyAnchorOf()`), so the person she answered is the person
 * whose relationship advances. Nobody is promoted for something they said earlier in a burst that
 * has already been replied to. A private session has one speaker, so this is that person.
 */
export function turnOwner(speakers: TurnSpeaker[]): TurnSpeaker | null {
  return speakers.length ? speakers[speakers.length - 1]! : null;
}

export async function processMessage(message: IncomingMessage): Promise<ProcessMessageResult> {
  // One line per turn showing where the time went. Cold-start stalls on this host used to
  // be invisible: the log could not tell "the model is slow" from "DNS took 5s".
  let mark = Date.now();
  const lap = (): number => {
    const now = Date.now();
    const ms = now - mark;
    mark = now;
    return ms;
  };

  const sessionKey = message.sessionKey;
  const group = isGroupSession(sessionKey);
  // Everyone who spoke in this turn, in arrival order. A private session has exactly one entry, so
  // the group path is a superset of it rather than a second code path.
  const speakers: TurnSpeaker[] = message.speakers?.length ? message.speakers : [{ userId: message.userId, user: message.user }];
  const owner = turnOwner(speakers) ?? { userId: message.userId, user: message.user };

  const history = restateHistory(getHistory(50, sessionKey), new Map(speakers.map((speaker) => [speaker.userId, speaker.user])));
  // Media is fetched here, once, and shared by both stages. It lands inside the `prep` lap
  // of the timing line, so a slow 20 MB download is attributable instead of mysterious.
  const media = await prepareMedia(message.mediaSources ?? []);
  // mediaSummary already names every attachment, so message.fileName (the *first* attachment's
  // name only) would duplicate it: "image0.png, image0.png [image]". Keep fileName as the fallback
  // for turns where media produced no summary at all.
  const fileName = media.summary || message.fileName;
  if (media.parts.length) {
    console.log(`[MEDIA] ${message.user}: ${media.parts.length} part(s) attached — ${media.summary}`);
  }
  saveMessage({ role: "user", userId: message.userId, user: message.user, text: message.text, timestamp: message.timestamp, fileName, sessionKey });
  const prepMs = lap();
  // An empty string is rejected outright by the embedding endpoint (verified: "content contains
  // an empty Part"), and media-only messages are common. Embed what the turn actually is instead.
  //
  // `embedText` deliberately keeps the `Name: ` prefix that createOnFlush() stamps on every line.
  // Stripping it looks like the obvious fix for bad recall and is the wrong one: the memories in the
  // collection name their person too ("คุณฟาริสขอไอล่าแต่งงาน…"), so the name is a *matching* signal.
  // Measured against the live collection — same query, prefix vs stripped: 0.8050 vs 0.6351, and
  // 0.7624 vs 0.5632. A merged multi-line turn costs a little (0.8050 → 0.7552 top-1 over five
  // lines), which is the price of answering a burst as one turn, and small next to the above.
  const embedText = message.text || media.summary || "(no text)";
  const vector = await embed(embedText);
  const embedMs = lap();
  // Retrieval is scoped inside the session AND filtered by similarity. The session key keeps one
  // person's facts out of another's context; the floor keeps a weak match out of *anyone's*, because
  // "the 8 nearest" from a collection of six is not eight memories — it is six guesses, and Isla was
  // handed another user's marriage proposal at cosine 0.42 and used it to turn down a newcomer.
  const memories = await recallMemories(vector, sessionKey);
  const chromaMs = lap();
  // One read of one table. This used to be two tables keyed by the same user_id, fetched twice,
  // and rendered by two functions that could disagree about the name.
  const identities = speakers.map((speaker) => {
    let profile = getUserProfile(speaker.userId);
    // Keep the stored name in step with Discord. `restateHistory()` only fixes what the *model sees*
    // this turn; without this write the row would keep whatever name it was created with, and the
    // next turn's block (and the forget CLI) would show a stale identity. Only the name is written,
    // so bond/xp/facts are never touched here. A first-time user gets their row created here too.
    if (!profile || profile.userName !== speaker.user) {
      profile = upsertUserProfile({ userId: speaker.userId, userName: speaker.user }) ?? profile;
    }
    return { userId: speaker.userId, userName: speaker.user, profile };
  });
  const profile = identities.find((identity) => identity.userId === owner.userId)?.profile ?? null;
  const identityBlock = identityBlockFor(identities, group, owner.userId);
  // Chroma stores UTC; the model reads Thai local time, same rule as messageStep().
  // `relevance` travels with each memory on purpose: these are the *closest* matches above a floor,
  // not verified facts about this conversation, and a 0.61 is a much weaker claim than a 0.85. The
  // prompt tells her to read that number rather than treat the list as certain (isla.md §1).
  const temporaryMemory = fakeToolCallResult("search_memory", { user: message.user }, {
    memories: memories.map((memory) => ({
      text: memory.text,
      timestamp: thaiTimestamp(memory.timestamp),
      relevance: Number((memory.score ?? 1).toFixed(2)),
    })),
  });
  const request1 = ctxWindowCreate(history, message.text, message.user, message.timestamp, fileName, temporaryMemory, message.userId, media.parts);
  const buildMs = lap();
  const response1 = await sendRequestGemini(request1, {
    // `currentTimeBlock()` is recomputed per turn on purpose: history and memory only carry the
    // timestamps of *past* rows, so without a server-side "now" the model has nothing to weigh a
    // claim about the time against (real case: "ยังไม่เที่ยงเลย" typed at 12:46:39+07:00, and Isla
    // agreed with it over her own context).
    //
    // The instruction is addressed to `owner.user` — the same person whose ladder moves below and
    // whose message the reply quotes, so the name in the prose cannot disagree with the name on the
    // transcript.
    systemInstruction: `${gemini1SystemPrompt(owner.user)}\n\n${identityBlock}\n\n${currentTimeBlock()}`,
    responseFormat: { type: "text", mime_type: "application/json", schema: fillPartnerIn(ISLA_REPLY_SCHEMA, owner.user) },
    debug: { userId: message.userId, userName: message.user },
  });
  const gemini1Ms = lap();
  // Gemini 1 answers as { Isla, summery }. Only `Isla` may reach the user or the history; the
  // recap is metadata. parseIslaReply degrades to "send the raw text" when the model ignores the
  // format, so a malformed turn still gets a reply instead of an empty message.
  const reply = parseIslaReply(typeof response1 === "string" ? response1 : "");
  if (!reply.parsed) {
    console.warn(`[PIPELINE] ${message.user}: Gemini 1 reply was not valid JSON -- sent raw text, no summery/mood/color`);
  } else if (reply.color === undefined) {
    // She named a colour we could not read. The reply still goes out, just without the accent
    // colour -- but say so, because a mood that never paints the embed is otherwise invisible.
    console.warn(
      `[PIPELINE] ${message.user}: gemini1 sent unusable color "${reply.colorText}" -- embed left default`,
    );
  }
  const responseText = reply.isla;
  const responseTimestamp = new Date().toISOString();
  // Her reply is stored under the SAME session key as the question it answers. It has always been
  // written with `user_id NULL` and that stays true — the session key is what makes it findable now,
  // which is the information the old global stream never needed.
  saveMessage({ role: "model", text: responseText, summary: reply.summery || null, timestamp: responseTimestamp, sessionKey });

  const state = await runGemini2(message, responseText, reply.summery, profile, media.parts, speakers, owner);
  const gemini2Ms = lap();
  const applied = await applyState(state, owner.userId, message.timestamp, owner.user, sessionKey);
  const applyMs = lap();
  console.log(`[PIPELINE] ${message.user}: total=${prepMs + embedMs + chromaMs + buildMs + gemini1Ms + gemini2Ms + applyMs}ms prep=${prepMs} embed=${embedMs} chroma=${chromaMs} build=${buildMs} gemini1=${gemini1Ms} gemini2=${gemini2Ms} apply=${applyMs}`);
  return {
    text: responseText,
    ...(applied.image ? { image: applied.image } : {}),
    ...(reply.mood && { mood: reply.mood }),
    ...(reply.color !== undefined && { color: reply.color }),
    status: applied.status,
  };
}
