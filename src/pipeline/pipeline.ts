import { ctxWindowCreate, fakeToolCallResult, sendRequestGemini, type GeminiRequest } from "../gemini/client.js";
import { prepareMedia, type MediaSource } from "../bot/media.js";
import { ISLA_REPLY_SCHEMA, parseIslaReply } from "../gemini/reply-format.js";
import { ISLA_STATE_SCHEMA, parseIslaState, requiredFieldsFor, romanticallyAvailable, type IslaState } from "../gemini/state-format.js";
import { currentTimeBlock, thaiTimestamp } from "../gemini/time.js";
import { imageListForPrompt } from "../bot/images.js";
import type { UserStatus } from "../bot/embed-footer.js";
import { embed } from "../memory/embedding.js";
import { saveMemoryVector, searchMemoriesByVector } from "../memory/chroma.js";
import { getHistory, saveMessage, type HistoryMessage } from "../sql/history.js";
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
  bondLabel,
  bondLadderWithThresholds,
  bondLevel,
  FLIRT_REQUIREMENT,
  PROPOSAL_XP,
  XP_THRESHOLDS,
} from "../sql/bonds.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config.js";
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
const systemPrompt = readFileSync(join(PROJECT_ROOT, config.paths.gemini1SystemPrompt), "utf8").trim();

/**
 * Gemini 2's instruction — the relationship analyst.
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
 * A function rather than a module-level const so that adding a picture takes effect on the next
 * message without a restart. While the directory is unchanged the returned string is byte-identical
 * across calls, so prompt caching is unaffected by the liveness.
 */
export function gemini2SystemPrompt(): string {
    return [
    "วิเคราะห์บทสนทนาระหว่าง Isla และผู้ใช้ในเทิร์นนี้ แล้วตอบเป็น JSON ตาม schema ที่กำหนดเท่านั้น",
    "",
    "สิ่งที่ต้องรายงาน:",
    "- affinity: คะแนนความสัมพันธ์ที่เปลี่ยนในเทิร์นนี้ (-100..100) — ค่านี้คือ xp ของระบบ แต่ให้คิดเป็น 'ความใกล้ชิด'",
    `  การคุยกันปกติ/ไม่ใช่ด้านลบ ต้องได้อย่างน้อย +${10}; หยาบคาย/ทำร้ายความรู้สึกติดลบ; ด่าซ้ำ ๆ หรือดูถูกแรง ๆ ติดลบลึก`,
    "- is_flirt: true เมื่อผู้ใช้จีบ/พูดหวาน/เข้าหาเชิงชู้สาว และ Isla ไม่ได้ปฏิเสธ — จำเป็นเมื่อผู้ใช้ยังพัฒนาเป็นแฟนได้",
    "- approve_lover: true เมื่อผู้ใช้ขอเป็นแฟน **และ Isla ตอบตกลงในข้อความของเธอเอง** — จำเป็นเมื่อระดับคือ crush",
    "- approve_soulmate: true เมื่อผู้ใช้ขอแต่งงาน **และ Isla ตอบตกลง** — จำเป็นเมื่อระดับคือ lover",
    "- approve_sibling / approve_family: เช่นเดียวกัน เมื่อผู้ใช้ขอเป็นพี่น้อง/ครอบครัว และ Isla ตอบตกลง",
    `- select_image: ชื่อไฟล์รูปของไอล่าที่ตรงกับอารมณ์ในข้อความของเธอที่สุดในเทิร์นนี้ ` +
    `ต้องเลือกจากรายการใน <expression_images> เท่านั้น (หรือส่ง "none" เมื่อไม่มีรูปไหนตรงจริง)`,
    "- add_facts: ข้อเท็จจริงเกี่ยวกับผู้ใช้โดยตรง (ไม่จำเป็น, ไม่เกิน 3 ข้อ, ไม่มีก็ส่ง [])",
    "- add_nicknames: ฉายาที่ไอล่าเพิ่งตั้งให้ผู้ใช้ในข้อความของเธอ (ไม่จำเป็น, ไม่มีก็ส่ง [])",
    "- ingest_memory: ความทรงจำที่ควรเก็บระยะยาว (ไม่จำเป็น, ไม่มีก็ส่ง \"\")",
    "",
    "กฎสำคัญ:",
    "1. ห้ามเลือกระดับความสัมพันธ์เอง — ไม่มีฟิลด์ bond ในคำตอบ ระบบจะคำนวณระดับจาก affinity, จำนวนครั้งที่ถูกจีบ และการตอบตกลงของเธอ",
    "2. approve_* คือการรายงานสิ่งที่ Isla ตอบไปในข้อความของเธอแล้ว ไม่ใช่การตัดสินใจใหม่ — ถ้าเธอไม่ตกลง ต้องส่ง false",
    "3. ส่งเฉพาะสิ่งที่เทิร์นนี้ทำให้เปลี่ยนจริง ๆ แต่ affinity และ select_image ต้องมีเสมอ",
    "",
    bondRulesBlock(),
    "",
    "<expression_images>",
    "ไฟล์รูปที่มีอยู่ในโฟลเดอร์ images — select_image ต้องเป็นชื่อไฟล์หนึ่งในนี้:",
    imageListForPrompt(),
    "</expression_images>",
    ].join("\n");
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
    `หมายเหตุ: ตัวเลขความสัมพันธ์เป็นข้อมูลภายใน อย่านำไปพูดกับผู้ใช้และอย่าแปลงเป็นคำพูดตรงตัว`,
    `</user_profile>`,
  ].join("\n");
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
    `ขอบเขต xp: enemy <= ${XP_THRESHOLDS[-1]}, stranger ${XP_THRESHOLDS[-1] + 1}..${XP_THRESHOLDS[1] - 1}, friend ${XP_THRESHOLDS[1]}..${XP_THRESHOLDS[2] - 1}, close_friend >= ${XP_THRESHOLDS[2]}`,
    `ฟิลด์ที่จำเป็นต้องตอบในเทิร์นนี้: ${requiredFieldsFor(bond).join(", ")}`,
    romanticallyAvailable(bond)
      ? `ระดับนี้พัฒนาเป็นเชิงชู้สาวได้ — ตอบ is_flirt ด้วย`
      : `ระดับนี้ไม่สามารถพัฒนาเป็นเชิงชู้สาวได้ — ไม่ต้องส่ง is_flirt`,
    `</current_state>`,
  ];
  return lines.join("\n");
}

/**
 * The ladder as Gemini 2 must read it.
 *
 * The rules are stated as *facts the model reports*, not as actions it may take — there is no
 * `set_bond` any more, and the text says so explicitly so the model does not try to name a rung.
 */
export function bondRulesBlock(): string {
  return [
    "<bond_levels>",
    bondLadderWithThresholds(),
    "",
    "เงื่อนไขที่ระบบใช้คำนวณระดับ (คุณไม่ต้องคำนวณเอง แค่รายงานสิ่งที่เกิดขึ้น):",
    `- ระดับเปลี่ยนจาก xp เป็นหลัก; crush ต้องมี flirt_count >= ${FLIRT_REQUIREMENT}`,
    `- ทุกครั้งที่ผู้ใช้จีบแล้ว Isla ไม่ปฏิเสธ จะนับ flirt_count +1 อัตโนมัติจาก is_flirt`,
    `- lover/soulmate/sibling/family ต้องมีการขอและ Isla ตอบตกลง (approve_*) และ xp >= ${PROPOSAL_XP}`,
    "- sibling/family อยู่ระดับ 3 และไปต่อเป็น lover/soulmate ไม่ได้เลยตลอดกาล",
    `- enemy เกิดเมื่อ xp <= ${XP_THRESHOLDS[-1]} และเมื่อกลับมาปกติจะกระโดดไปที่ friend เท่านั้น`,
    "ห้ามเลือกระดับความสัมพันธ์เอง ส่งแค่สัญญาณของเทิร์นนี้",
    "</bond_levels>",
  ].join("\n");
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
 * Exported so the contract can be tested without a Gemini round-trip.
 */
export async function applyState(state: IslaState, userId: string, timestamp: string, userName: string): Promise<TurnApplyResult> {
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
    await saveMemoryVector(
      { id: crypto.randomUUID(), text: state.ingestMemory, userId, timestamp },
      await embed(state.ingestMemory),
    );
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
): Promise<IslaState> {
  const analysisInput = [
    `${message.user}: ${message.text}`,
    `Isla: ${responseText}`,
    ...(summery ? [`(สรุปของข้อความนี้: ${summery})`] : []),
    ``,
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
    systemInstruction: gemini2SystemPrompt(),
    responseFormat: { type: "text", mime_type: "application/json", schema: ISLA_STATE_SCHEMA },
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
// "name: " prefix the scheduler merges into text. Re-stamp this sender's past turns with
// their current display name so the model sees one consistent identity after a rename.
export function restateHistory(history: HistoryMessage[], userId: string, user: string): HistoryMessage[] {
  return history.map((entry) => {
    if (entry.role !== "user" || entry.userId !== userId) return entry;
    const stale = entry.user;
    if (!stale || stale === user) return { ...entry, user };
    const text = entry.text.replace(new RegExp(`^${escapeRegExp(stale)}: `, "gm"), `${user}: `);
    return { ...entry, user, text };
  });
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

  const history = restateHistory(getHistory(50), message.userId, message.user);
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
  saveMessage({ role: "user", userId: message.userId, user: message.user, text: message.text, timestamp: message.timestamp, fileName });
  const prepMs = lap();
  // An empty string is rejected outright by the embedding endpoint (verified: "content contains
  // an empty Part"), and media-only messages are common. Embed what the turn actually is instead.
  const embedText = message.text || media.summary || "(no text)";
  const vector = await embed(embedText);
  const embedMs = lap();
  const memories = await searchMemoriesByVector(vector, 8);
  const chromaMs = lap();
  // One read of one table. This used to be two tables keyed by the same user_id, fetched twice,
  // and rendered by two functions that could disagree about the name.
  let profile = getUserProfile(message.userId);
  // Keep the stored name in step with Discord. `restateHistory()` only fixes what the *model sees*
  // this turn; without this write the row would keep whatever name it was created with, and the
  // next turn's block (and the forget CLI) would show a stale identity. Only the name is written,
  // so bond/xp/facts are never touched here. A first-time user gets their row created here too.
  if (!profile || profile.userName !== message.user) {
    profile = upsertUserProfile({ userId: message.userId, userName: message.user }) ?? profile;
  }
  const identityBlock = profileBlock(profile, message.user);
  // Chroma stores UTC; the model reads Thai local time, same rule as messageStep().
  const temporaryMemory = fakeToolCallResult("search_memory", { user: message.user }, { memories: memories.map((memory) => ({ text: memory.text, timestamp: thaiTimestamp(memory.timestamp) })) });
  const request1 = ctxWindowCreate(history, message.text, message.user, message.timestamp, fileName, temporaryMemory, message.userId, media.parts);
  const buildMs = lap();
  const response1 = await sendRequestGemini(request1, {
    // `currentTimeBlock()` is recomputed per turn on purpose: history and memory only carry the
    // timestamps of *past* rows, so without a server-side "now" the model has nothing to weigh a
    // user's false time claim against (real case: "ยังไม่เที่ยงเลย" typed at 12:46:39+07:00, and
    // Isla agreed with the user over her own context). Gemini 2 deliberately does NOT get it —
    // it only picks tools, and a per-turn instruction string would break its prompt caching.
    systemInstruction: `${systemPrompt}\n\n${identityBlock}\n\n${currentTimeBlock()}`,
    responseFormat: { type: "text", mime_type: "application/json", schema: ISLA_REPLY_SCHEMA },
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
  saveMessage({ role: "model", text: responseText, summary: reply.summery || null, timestamp: responseTimestamp });

  const state = await runGemini2(message, responseText, reply.summery, profile, media.parts);
  const gemini2Ms = lap();
  const applied = await applyState(state, message.userId, message.timestamp, message.user);
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
