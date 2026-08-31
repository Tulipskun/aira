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
};

export const BOND_LEVELS: Record<BondLevel, BondInfo> = {
  stranger: { level: 0, label: "คนแปลกหน้า", emoji: "👋" },
  friend: { level: 1, label: "เพื่อน", emoji: "🙂" },
  close_friend: { level: 2, label: "เพื่อนสนิท", emoji: "🤗" },
  crush: { level: 3, label: "แอบชอบ", emoji: "💗" },
  lover: { level: 4, label: "คนรัก", emoji: "❤️" },
  soulmate: { level: 5, label: "คู่แท้", emoji: "💞" },
  // Falling out with her does not walk down the ladder, it lands here — and climbing back out
  // lands on `friend` (level 1), never on `stranger`.
  enemy: { level: -1, label: "ศัตรู", emoji: "💢", jumpTo: "friend" },
  // Family is fixed at level 3 and can never become romantic: the ladder stops at level 3.
  sibling: { level: 3, label: "พี่น้อง", emoji: "🌱", maxLevel: 3 },
  family: { level: 3, label: "ครอบครัว", emoji: "🏠", maxLevel: 3 },
};

export const BOND_NAMES = Object.keys(BOND_LEVELS) as BondLevel[];

/** Level 0 rungs, in ladder order — used to render the ladder for the model. */
const ASCENDING: BondLevel[] = ["stranger", "friend", "close_friend", "crush", "lover", "soulmate"];
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
 * The same ladder with the xp gates spelled out — what Gemini 2 is given.
 *
 * Kept separate from `bondLadderText()` because Gemini 1 also reads the plain version, and showing
 * it the numeric gates invites it to talk about a score with the user.
 */
export function bondLadderWithThresholds(): string {
  const lines = [
    `- stranger (ระดับ 0) = คนแปลกหน้า — xp ${XP_THRESHOLDS[-1] + 1}..${XP_THRESHOLDS[1] - 1}`,
    `- friend (ระดับ 1) = เพื่อน — xp >= ${XP_THRESHOLDS[1]}`,
    `- close_friend (ระดับ 2) = เพื่อนสนิท — xp >= ${XP_THRESHOLDS[2]}`,
    `- crush (ระดับ 3) = แอบชอบ — xp >= ${XP_THRESHOLDS[3]} และถูกจีบสะสม >= ${FLIRT_REQUIREMENT} ครั้ง`,
    `- lover (ระดับ 4) = คนรัก — ต้องเป็น crush ก่อน + ผู้ใช้ขอคบ + Isla ตอบตกลง (xp >= ${PROPOSAL_XP})`,
    `- soulmate (ระดับ 5) = คู่แท้ — ต้องเป็น lover ก่อน + ผู้ใช้ขอแต่งงาน + Isla ตอบตกลง (xp >= ${PROPOSAL_XP})`,
    `- sibling (ระดับ 3) = พี่น้อง — xp >= ${PROPOSAL_XP} + ขอเป็นพี่น้อง + Isla ตอบตกลง (ไประดับ 4 ไม่ได้)`,
    `- family (ระดับ 3) = ครอบครัว — xp >= ${PROPOSAL_XP} + ขอเป็นครอบครัว + Isla ตอบตกลง (ไประดับ 4 ไม่ได้)`,
    `- enemy (ระดับ -1) = ศัตรู — xp <= ${XP_THRESHOLDS[-1]} (กลับมาปกติต้องไปที่ friend เท่านั้น)`,
  ];
  return lines.join("\n");
}

/* ------------------------------------------------------------------ *
 * Deriving the rung — the model reports facts, this decides the bond.
 * ------------------------------------------------------------------ */

/** xp needed to reach each rung on the romantic ladder, by level. */
export const XP_THRESHOLDS: Record<number, number> = {
  [-1]: -150, // enemy
  0: -149, // stranger: anywhere between the two enemy walls
  1: 150, // friend
  2: 500, // close_friend
  3: 500, // crush (also needs FLIRT_REQUIREMENT accepted flirts)
  4: 500, // lover (also needs the proposal accepted)
  5: 500, // soulmate (also needs the proposal accepted)
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
  if (xp < XP_THRESHOLDS[2]) return "friend";
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
 * The owner's ladder puts sibling/family/lover/soulmate at level 3+, which begins at 500 xp — the
 * same bar as `close_friend`. A yes below that bar is remembered, not thrown away (see `pending`).
 */
export const PROPOSAL_XP = XP_THRESHOLDS[2];

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
 *     prerequisites still apply: xp must reach `PROPOSAL_XP`, `soulmate` only advances a `lover`,
 *     `lover` only advances a `crush`, and a capped rung (sibling/family) can never become romantic
 *     no matter what gets approved. When xp is not there yet the approval stays **pending** instead
 *     of being dropped, so she cannot undo her own yes by warming up slowly.
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
      if (approvals.lover && current === "crush") {
        return { bond: "lover", xp, reason: `lover proposal accepted while crush (xp ${xp})`, changed: true, consumed: ["lover"] };
      }
    }
  }
  // Said yes, but the ladder cannot grant it yet. Kept pending so the next turn can finish it.
  const pending = (["family", "sibling", "soulmate", "lover"] as ApprovalName[]).filter((name) => approvals[name] && !enoughXp);

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
  } else if (rank < keep && keep <= 2) {
    // Only the xp-only rungs decay, and they decay no lower than `friend`.
    //
    // `stranger` is a starting state, never a destination: you cannot un-meet someone. Without this
    // floor the enemy rule would cancel itself out — recovering from enemy lands on `friend` at an
    // xp that the bands still call `stranger`, so the very next turn would demote it back and the
    // jump would be worth nothing. Falling all the way still happens; it just goes through `enemy`.
    bond = rank === 0 ? "friend" : byXp;
    reason = rank === 0 ? `xp ${xp} is below the friend band, but stranger is not a fallback` : `xp ${xp} fell back to level ${rank}`;
  }

  if (capped && BOND_LEVELS[bond].level < 3) {
    // Leaving a capped rung downward is allowed (family can fall out with her), but climbing back
    // into the romantic ladder is not.
    bond = "close_friend";
    reason += " — capped rung cannot climb";
  }

  // `crush` is the one rung that needs more than xp.
  if (bond === "close_friend" && BOND_LEVELS[current].level < 3) {
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
