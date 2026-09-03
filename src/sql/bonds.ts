/**
 * Bond levels — the relationship ladder between Isla and a user.
 *
 * This module is the single source of truth for the ladder: the rank numbers, the Thai labels,
 * and the two rules that make some rungs special (enemy and the capped family rungs). The schema
 * in `profile.ts` stores `bond` as a plain TEXT with no CHECK constraint on purpose, so a level
 * can be added here without an ALTER TABLE, and `normalizeBond()` is what decides whether a
 * stored value is still valid.
 */

export type BondLevel =
  | "stranger"
  | "acquaintance"
  | "friend"
  | "close_friend"
  | "crush"
  | "lover"
  | "soulmate"
  | "enemy"
  | "sibling"
  | "family";

export type BondInfo = {
  /** Ordering of the ladder. Negative for enemy. */
  level: number;
  /** Thai label shown to the model. */
  label: string;
  /**
   * One mark per rung, for the Discord embed footer (`Farris (คนรัก) ❤️ 199`).
   *
   * Kept next to `label` rather than in a display module so a rung cannot be added without one,
   * and so the footer never invents a symbol the ladder does not recognise.
   */
  emoji: string;
  /** Highest rung this bond can develop to. Omitted means "as high as it goes". */
  maxLevel?: number;
  /**
   * Leaving this bond never walks the ladder: it jumps straight to `jumpTo`.
   * Enemy is the only such rung — once you are her enemy, making up does not make
   * you a friend-in-progress, it makes you a friend.
   */
  jumpTo?: BondLevel;
  /**
   * Name used when the embed footer announces that this rung was reached
   * (`[Lover Unlocked]`). Omitted means "never announced".
   *
   * Two rungs have no label on purpose, and the absence *is* the rule so a new rung cannot
   * accidentally claim one:
   *  - `stranger` is where everyone starts, so arriving there is not an achievement (and the ladder
   *    never demotes to it anyway);
   *  - `enemy` is a fall-out, not a condition passed — the owner's wording is "ผ่านเงื่อนไข", which
   *    a demotion is not.
   *
   * English rather than Thai because the footer's other badge (`[Flirt +1]`) is English too, and one
   * language keeps the two brackets looking like a pair.
   */
  unlockLabel?: string;
  /**
   * How this rung is granted, in the form Gemini 2 is shown.
   *
   * Data rather than a hand-written paragraph in `bondLadderWithThresholds()`: that function used to
   * be nine literal lines repeating each rung's name, level and label a second time, so adding a
   * rung here left it silently absent from the text the model reads. `ask` is what the user has to
   * request, in Thai, for the proposal-based rungs.
   */
  reach?: "band" | "xp" | "xpWithFlirts" | "proposal" | "proposalCapped" | "enemy";
  /** For `proposal`: the rung the user must already hold for an accepted request to grant this one. */
  reachAfter?: BondLevel;
  /** For the proposal rungs: what the user has to ask for, in Thai. */
  ask?: string;
};

export const BOND_LEVELS: Record<BondLevel, BondInfo> = {
  // No unlockLabel: everyone starts here, so arriving is not news (see BondInfo.unlockLabel).
  stranger: { level: 0, label: "คนแปลกหน้า", emoji: "👋", reach: "band" },
  acquaintance: { level: 1, label: "คนรู้จัก", emoji: "🤝", unlockLabel: "Acquaintance", reach: "xp" },
  friend: { level: 2, label: "เพื่อน", emoji: "🙂", unlockLabel: "Friend", reach: "xp" },
  close_friend: { level: 3, label: "เพื่อนสนิท", emoji: "🤗", unlockLabel: "Close Friend", reach: "xp" },
  crush: { level: 4, label: "แอบชอบ", emoji: "💗", unlockLabel: "Crush", reach: "xpWithFlirts" },
  lover: { level: 5, label: "คนรัก", emoji: "❤️", unlockLabel: "Lover", reach: "proposal", reachAfter: "crush", ask: "ขอคบ" },
  soulmate: { level: 6, label: "คู่แท้", emoji: "💞", unlockLabel: "Soulmate", reach: "proposal", reachAfter: "lover", ask: "ขอแต่งงาน" },
  // Falling out with her does not walk down the ladder, it lands here — and climbing back out
  // lands on `friend` (level 2), never on `stranger`. No unlockLabel: a fall-out is not a
  // condition passed.
  enemy: { level: -1, label: "ศัตรู", emoji: "💢", jumpTo: "friend", reach: "enemy" },
  // Family is fixed at level 4 and can never become romantic: the ladder stops at level 4.
  sibling: { level: 4, label: "พี่น้อง", emoji: "🌱", maxLevel: 4, unlockLabel: "Sibling", reach: "proposalCapped", ask: "ขอเป็นพี่น้อง" },
  family: { level: 4, label: "ครอบครัว", emoji: "🏠", maxLevel: 4, unlockLabel: "Family", reach: "proposalCapped", ask: "ขอเป็นครอบครัว" },
};

export const BOND_NAMES = Object.keys(BOND_LEVELS) as BondLevel[];

/** Level 0 rungs, in ladder order — used to render the ladder for the model. */
const ASCENDING: BondLevel[] = ["stranger", "acquaintance", "friend", "close_friend", "crush", "lover", "soulmate"];
/** Rungs that are not part of the romantic ladder. */
const SPECIAL: BondLevel[] = ["sibling", "family", "enemy"];

export function isBond(value: unknown): value is BondLevel {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(BOND_LEVELS, value);
}

/** Numeric rank of a bond, or `null` for an unknown value. */
export function bondLevel(bond: string | null | undefined): number | null {
  return isBond(bond) ? BOND_LEVELS[bond].level : null;
}

/** Thai label for a bond, or the raw value when it is not a known rung. */
export function bondLabel(bond: string | null | undefined): string {
  return isBond(bond) ? BOND_LEVELS[bond].label : String(bond ?? "");
}

/**
 * The bond's mark, or "" for an unknown rung.
 *
 * Empty rather than a placeholder: a footer with no symbol is legible, one with the *wrong*
 * symbol claims a relationship the ladder never granted.
 */
export function bondEmoji(bond: string | null | undefined): string {
  return isBond(bond) ? BOND_LEVELS[bond].emoji : "";
}

/**
 * The rung's announcement name, or "" when the footer must not announce it.
 *
 * `""` for `stranger`/`enemy` and for any unknown value — the same "no placeholder" rule as
 * `bondEmoji()`: an empty badge is absent, a wrong badge claims a relationship the ladder did not
 * grant.
 */
export function bondUnlockLabel(bond: string | null | undefined): string {
  return isBond(bond) ? (BOND_LEVELS[bond].unlockLabel ?? "") : "";
}

/**
 * Is moving `from` -> `to` an unlock worth announcing?
 *
 * Three rules, each covering a way a footer could otherwise lie:
 *  1. The target must have an `unlockLabel` — that is what keeps `stranger` and `enemy` silent.
 *  2. `from === to` is never an unlock; a rung held is not a rung reached.
 *  3. A *demotion* is never an unlock. `close_friend -> friend` is xp falling, not a condition
 *     passed, so it must not print `[Friend Unlocked]` on the way down. Sideways moves at the same
 *     level (e.g. an accepted `family` proposal from `crush`) do count: the rung is new to them.
 */
export function isBondUnlock(from: string | null | undefined, to: string | null | undefined): boolean {
  // `isBond()` rather than `bondUnlockLabel()` as the guard: it is the type predicate, so `to` stays
  // usable as a key below, and reading the field directly keeps the "no label = silent" rule in one
  // place.
  if (!isBond(to)) return false;
  if (!BOND_LEVELS[to].unlockLabel) return false;
  if (!isBond(from)) return true;
  if (from === to) return false;
  return BOND_LEVELS[to].level >= BOND_LEVELS[from].level;
}

/**
 * The highest rung this bond can reach, as a bond name.
 * `sibling`/`family` cap at `crush`'s rung (level 3) — they sit at level 3 and cannot develop
 * further, so level 4 (`lover`) is out of reach. Everything else tops out at `soulmate`.
 */
export function bondCeiling(bond: BondLevel): BondLevel {
  const info = BOND_LEVELS[bond];
  if (info.maxLevel === undefined) return "soulmate";
  return ASCENDING.find((name) => BOND_LEVELS[name].level === info.maxLevel) ?? bond;
}

/**
 * The bond to use after leaving `enemy`.
 *
 * Enemy is a one-way door: recovery never passes through `stranger`, it jumps to `friend`.
 * Returns null when `bond` is not enemy, so callers can distinguish "no jump rule" from
 * "the jump produced this".
 */
export function bondRecoveryFrom(bond: string | null | undefined): BondLevel | null {
  return isBond(bond) ? (BOND_LEVELS[bond].jumpTo ?? null) : null;
}

/** The ladder as text, for prompts. */
export function bondLadderText(): string {
  const rungs = [...ASCENDING, ...SPECIAL].map((name) => {
    const info = BOND_LEVELS[name];
    const notes: string[] = [];
    if (info.maxLevel !== undefined) notes.push(`ไปต่อได้ถึงระดับ ${info.maxLevel} เท่านั้น (ห้ามไปถึง lover)`);
    if (info.jumpTo) notes.push(`ถ้ากลับมาปกติต้องกระโดดไปที่ ${info.jumpTo} (ระดับ ${BOND_LEVELS[info.jumpTo].level}) เท่านั้น`);
    return `- ${name} (ระดับ ${info.level}) = ${info.label}${notes.length ? ` — ${notes.join("; ")}` : ""}`;
  });
  return rungs.join("\n");
}

/**
 * The xp band of each rung granted by xp alone, as a bare range.
 *
 * `deriveBond()` reads `XP_THRESHOLDS` directly; these strings are the same arithmetic in the form the
 * model is shown. They exist because the stranger/friend/close_friend bands were computed in two
 * places (the ladder text and Gemini 2's per-turn `<current_state>`), and a band edited in only one of
 * them would tell the model the ladder says something it does not.
 */
export function xpBandRange(bond: "enemy" | "stranger" | "acquaintance" | "friend" | "close_friend"): string {
  switch (bond) {
    case "enemy":
      return `<= ${XP_THRESHOLDS[-1]}`;
    case "stranger":
      return `${XP_THRESHOLDS[-1] + 1}..${XP_THRESHOLDS[1] - 1}`;
    case "acquaintance":
      return `${XP_THRESHOLDS[1]}..${XP_THRESHOLDS[2] - 1}`;
    case "friend":
      return `${XP_THRESHOLDS[2]}..${XP_THRESHOLDS[3] - 1}`;
    case "close_friend":
      return `>= ${XP_THRESHOLDS[3]}`;
  }
}

/** The same bands as one line: `enemy <= -150, stranger -149..49, acquaintance 50..149, friend 150..299, close_friend >= 300`. */
export function xpBandsText(): string {
  return (["enemy", "stranger", "acquaintance", "friend", "close_friend"] as const)
    .map((bond) => `${bond} ${xpBandRange(bond)}`)
    .join(", ");
}

/**
 * The same ladder with the xp gates spelled out — what Gemini 2 is given.
 *
 * Generated from `BOND_LEVELS[*].reach` rather than typed out line by line. It used to be nine
 * literal strings that repeated each rung's name, level and label, so a rung added to the ladder
 * above silently went missing from the text the model reads — and the numbers in it
 * (`xp >= 300`, `>= ${FLIRT_REQUIREMENT}`) were a fourth copy of thresholds that `deriveBond()`
 * reads from `XP_THRESHOLDS` directly.
 *
 * Kept separate from `bondLadderText()` because Gemini 1 also reads the plain version, and showing
 * it the numeric gates invites it to talk about a score with the user.
 */
export function bondLadderWithThresholds(partner?: string | null): string {
  // Named, not "the user": this text is how the analyst learns what earns a rung, and in a shared
  // room a rule about "the user" is a rule about nobody in particular. `partner` is the display name
  // of whoever this turn's ladder is, already resolved by the caller — this module stays import-free
  // on purpose, so the name arrives sanitised rather than being cleaned here. Without one, the line
  // keeps the generic Thai phrasing it has always had.
  const who = partner?.trim() ? ` ${partner.trim()} ` : "";
  const lines = [...ASCENDING, ...SPECIAL].map((name) => {
    const info = BOND_LEVELS[name];
    const head = `- ${name} (ระดับ ${info.level}) = ${info.label}`;
    switch (info.reach) {
      case "band":
        return `${head} — xp ${xpBandRange("stranger")}`;
      case "xp":
        return `${head} — xp >= ${XP_THRESHOLDS[info.level]}`;
      case "xpWithFlirts":
        return `${head} — xp >= ${XP_THRESHOLDS[info.level]} และ${who ? `${who}ถูก` : "ถูก"}จีบสะสม >= ${FLIRT_REQUIREMENT} ครั้ง`;
      case "proposal":
        return `${head} — ต้องเป็น ${info.reachAfter} ก่อน +${who || " อีกฝ่าย"}${info.ask} + Isla ตอบตกลง (xp >= ${PROPOSAL_XP})`;
      case "proposalCapped": {
        // "ไประดับ 4 ไม่ได้" — 4 is the first rung above this one's ceiling, read off the ladder so
        // the sentence cannot claim a level that does not exist.
        const above = ASCENDING.find((rung) => BOND_LEVELS[rung].level > (info.maxLevel ?? info.level));
        return `${head} — xp >= ${PROPOSAL_XP} + ${info.ask} + Isla ตอบตกลง${above ? ` (ไประดับ ${BOND_LEVELS[above].level} ไม่ได้)` : ""}`;
      }
      case "enemy":
        return `${head} — xp ${xpBandRange("enemy")}${info.jumpTo ? ` (กลับมาปกติต้องไปที่ ${info.jumpTo} เท่านั้น)` : ""}`;
      default:
        // A rung with no `reach` is a rung nobody can earn, so say nothing rather than invent a rule.
        return head;
    }
  });
  return lines.join("\n");
}

/* ------------------------------------------------------------------ *
 * Deriving the rung — the model reports facts, this decides the bond.
 * ------------------------------------------------------------------ */

/** xp needed to reach each rung on the romantic ladder, by level. */
export const XP_THRESHOLDS: Record<number, number> = {
  [-1]: -150, // enemy
  0: -149, // stranger: anywhere between the two enemy walls
  1: 50, // acquaintance
  2: 150, // friend
  3: 300, // close_friend
  4: 300, // crush (also needs FLIRT_REQUIREMENT accepted flirts)
  5: 300, // lover (also needs the proposal accepted)
  6: 300, // soulmate (also needs the proposal accepted)
};

/** Accepted flirtatious approaches needed before the user can become a `crush`. */
export const FLIRT_REQUIREMENT = 5;

/** Rungs that sit at level 3 and can never become romantic. */
const CAPPED: BondLevel[] = ["sibling", "family"];

export function isCappedBond(bond: BondLevel): boolean {
  return CAPPED.includes(bond);
}

/** The rung for a given xp on the ascending ladder, ignoring flirt/approval gates. */
export function bondForXp(xp: number): BondLevel {
  if (xp <= XP_THRESHOLDS[-1]) return "enemy";
  if (xp < XP_THRESHOLDS[1]) return "stranger";
  if (xp < XP_THRESHOLDS[2]) return "acquaintance";
  if (xp < XP_THRESHOLDS[3]) return "friend";
  return "close_friend";
}

/** What `deriveBond` decided, and why — the reason is logged so a stuck ladder is visible. */
export type BondDerivation = {
  bond: BondLevel;
  xp: number;
  /** Human/developer-readable explanation of the winning rule. */
  reason: string;
  /** True when the rung changed from `from`. */
  changed: boolean;
  /** Approvals actually used, so the caller can clear only those flags from storage. */
  consumed: ApprovalName[];
};

/** The proposal-based rungs. `lover`/`soulmate` are romantic; `sibling`/`family` are capped. */
export type ApprovalName = "lover" | "soulmate" | "sibling" | "family";

/**
 * The xp every proposal-based rung needs before an accepted proposal can be granted.
 *
 * The owner's ladder puts sibling/family/lover/soulmate at level 3+, which begins at 300 xp — the
 * same bar as `close_friend`. A yes below that bar is remembered, not thrown away (see `pending`).
 */
export const PROPOSAL_XP = XP_THRESHOLDS[3];

/**
 * The signals Gemini 2 reported about this turn.
 *
 * No bond name in here on purpose: the model says what happened, never what it means for the
 * ladder.
 */
export type BondSignals = {
  /** Accepted flirtatious approaches, all-time, *including* this turn's. */
  flirtCount: number;
  /**
   * Proposals Isla accepted — newly accepted this turn, or accepted earlier and still waiting on
   * xp. A flag is cleared only when it actually moved the rung.
   */
  approvals?: Partial<Record<ApprovalName, boolean>>;
};

/**
 * Decide the bond from xp + the model's signals. Never from a rung the model named.
 *
 * Order matters, and each rule exists because of a specific way a model could otherwise break the
 * ladder:
 *  1. An accepted proposal is honoured — it is a promise she already made out loud. The ladder's
 *     prerequisites still apply: xp must reach `PROPOSAL_XP`, `soulmate` advances a `lover` (and a
 *     `crush` who was proposed to gets `lover` first, so the promise is never stranded), and a
 *     capped rung (sibling/family) can never become romantic no matter what gets approved. When the
 *     grant is not due yet the approval stays **pending** instead of being dropped, so she cannot
 *     undo her own yes by warming up slowly.
 *  2. Enemy is entered on xp alone, and left by jumping to `friend` — never through `stranger`.
 *  3. Everything else walks the ladder by xp, and `crush` additionally requires
 *     `FLIRT_REQUIREMENT` accepted flirts.
 *
 * A rung never *decays* past level 2: falling xp demotes stranger/friend/close_friend, but an
 * established crush/lover/soulmate/sibling/family is kept, because those were granted by a decision
 * rather than a score.
 */
export function deriveBond(from: string | null | undefined, xp: number, signals: BondSignals): BondDerivation {
  const current: BondLevel = isBond(from) ? from : "stranger";
  const capped = isCappedBond(current);
  const approvals = signals.approvals ?? {};
  const enoughXp = xp >= PROPOSAL_XP;

  // --- 1. accepted proposals ---
  if (enoughXp) {
    if (approvals.family) {
      return { bond: "family", xp, reason: `family accepted (xp ${xp})`, changed: current !== "family", consumed: ["family"] };
    }
    if (approvals.sibling) {
      return { bond: "sibling", xp, reason: `sibling accepted (xp ${xp})`, changed: current !== "sibling", consumed: ["sibling"] };
    }
    if (!capped) {
      if (approvals.soulmate && current === "lover") {
        return { bond: "soulmate", xp, reason: `marriage accepted while lover (xp ${xp})`, changed: true, consumed: ["soulmate"] };
      }
      // A marriage accepted while still `crush` is a promise the ladder used to hold forever: the
      // soulmate rule only fires from `lover`, and nothing in a conversation forces the user to
      // propose dating separately first — he already proposed *marriage*. Nobody marries someone
      // they are not dating, so the yes contains the lover rung. Grant it now and leave `soulmate`
      // pending (consumed is empty), so the next turn finishes the climb on its own.
      if (approvals.soulmate && current === "crush") {
        return {
          bond: "lover",
          xp,
          reason: `marriage accepted while crush — grants lover first, soulmate stays pending (xp ${xp})`,
          changed: true,
          consumed: [],
        };
      }
      if (approvals.lover && current === "crush") {
        return { bond: "lover", xp, reason: `lover proposal accepted while crush (xp ${xp})`, changed: true, consumed: ["lover"] };
      }
    }
  }
  // Said yes, but the ladder cannot grant it yet — either xp is short *or* the prerequisite rung
  // is not there yet (a `lover` yes while still `close_friend` is the common one). Kept pending so
  // the next turn can finish it, and named in the reason either way: a yes that vanishes from the
  // log reads to the operator as "the model never reported it", which is the wrong diagnosis.
  //
  // A flag for a rung already held is not pending — `approved_lover` stays set when a second yes
  // arrives at `lover` (nothing consumes it there), and reporting it would claim a promise the
  // ladder has already kept.
  const pending = (["family", "sibling", "soulmate", "lover"] as ApprovalName[]).filter(
    (name) => approvals[name] && BOND_LEVELS[current].level < BOND_LEVELS[name].level,
  );

  // --- 2. enemy, and the one-way door out of it ---
  if (xp <= XP_THRESHOLDS[-1]) {
    return { bond: "enemy", xp, reason: `xp ${xp} <= ${XP_THRESHOLDS[-1]}`, changed: current !== "enemy", consumed: [] };
  }
  if (current === "enemy") {
    const jump = bondRecoveryFrom(current)!;
    return { bond: jump, xp, reason: `recovered from enemy — jumps to ${jump}`, changed: true, consumed: [] };
  }

  // --- 3. walk the ladder by xp ---
  const byXp = bondForXp(xp);
  const rank = BOND_LEVELS[byXp].level;
  const keep = BOND_LEVELS[current].level;
  let bond: BondLevel = current;
  let reason = `xp ${xp} supports level ${rank}, keeping ${current}`;

  if (rank > keep) {
    bond = byXp;
    reason = `xp ${xp} reached level ${rank}`;
  } else if (rank < keep && keep <= 3) {
    // Only the xp-only rungs (acquaintance/friend/close_friend) decay, and they decay no lower
    // than `friend`.
    //
    // `stranger` is a starting state, never a destination: you cannot un-meet someone. Without this
    // floor the enemy rule would cancel itself out — recovering from enemy lands on `friend` at an
    // xp that the bands still call `stranger`, so the very next turn would demote it back and the
    // jump would be worth nothing. Falling all the way still happens; it just goes through `enemy`.
    bond = rank === 0 ? "friend" : byXp;
    reason = rank === 0 ? `xp ${xp} is below the friend band, but stranger is not a fallback` : `xp ${xp} fell back to level ${rank}`;
  }

  if (capped && BOND_LEVELS[bond].level < 4) {
    // Leaving a capped rung downward is allowed (family can fall out with her), but climbing back
    // into the romantic ladder is not.
    bond = "close_friend";
    reason += " — capped rung cannot climb";
  }

  // `crush` is the one rung that needs more than xp.
  if (bond === "close_friend" && BOND_LEVELS[current].level < 4) {
    if (signals.flirtCount >= FLIRT_REQUIREMENT) {
      bond = "crush";
      reason = `xp ${xp} + ${signals.flirtCount} accepted flirts (>= ${FLIRT_REQUIREMENT})`;
    } else {
      reason = `xp ${xp} reaches crush but only ${signals.flirtCount}/${FLIRT_REQUIREMENT} flirts`;
    }
  }

  if (pending.length) reason += ` — pending: ${pending.join(", ")}`;

  return { bond, xp, reason, changed: bond !== current, consumed: [] };
}
