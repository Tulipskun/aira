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
  stranger: { level: 0, label: "คนแปลกหน้า" },
  friend: { level: 1, label: "เพื่อน" },
  close_friend: { level: 2, label: "เพื่อนสนิท" },
  crush: { level: 3, label: "แอบชอบ" },
  lover: { level: 4, label: "คนรัก" },
  soulmate: { level: 5, label: "คู่แท้" },
  // Falling out with her does not walk down the ladder, it lands here — and climbing back out
  // lands on `friend` (level 1), never on `stranger`.
  enemy: { level: -1, label: "ศัตรู", jumpTo: "friend" },
  // Family is fixed at level 3 and can never become romantic: the ladder stops at level 3.
  sibling: { level: 3, label: "พี่น้อง", maxLevel: 3 },
  family: { level: 3, label: "ครอบครัว", maxLevel: 3 },
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
 * Resolve a requested bond change against the rules.
 *
 * `from` is the current bond (null/unknown = stranger). Returns the bond to store, or null when
 * the request is refused (unknown name, or a rung above this bond's ceiling).
 */
export function resolveBondChange(from: string | null | undefined, to: string | null | undefined): BondLevel | null {
  if (!isBond(to)) return null;
  const current: BondLevel = isBond(from) ? from : "stranger";
  if (to === current) return to;
  // A capped rung cannot be climbed past. Coming *into* a capped rung is always allowed —
  // being made family is not something the ceiling should block.
  const info = BOND_LEVELS[current];
  if (info.maxLevel !== undefined && BOND_LEVELS[to].level > info.maxLevel) return null;
  // A jump rung never walks the ladder on the way out: leaving enemy lands on `friend`, never on
  // `stranger`. Without this the rule would only exist as text in the prompt.
  const jump = bondRecoveryFrom(current);
  if (jump && BOND_LEVELS[to].level < BOND_LEVELS[jump].level) return jump;
  return to;
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

/**
 * Clamp a bond to a numeric level, honouring the ceiling.
 * Used by stat adjustments that express progress as a level rather than a rung name.
 */
export function clampBondToLevel(bond: BondLevel, level: number): BondLevel {
  const ceiling = BOND_LEVELS[bond].maxLevel;
  const target = ceiling !== undefined ? Math.min(level, ceiling) : level;
  return ASCENDING.find((name) => BOND_LEVELS[name].level === target) ?? (ceiling !== undefined ? bond : "soulmate");
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
