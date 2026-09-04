/**
 * Bond levels — the relationship ladder between Isla and a user.
 * This module is the single source of truth for the relationship ladder and its progression rules.
 */

export type BondLevel =
  | "stranger" | "acquaintance" | "friend" | "close_friend" | "crush" | "lover"
  | "soulmate" | "enemy" | "sibling" | "family";

export type BondInfo = {
  level: number;
  label: string;
  emoji: string;
  maxLevel?: number;
  jumpTo?: BondLevel;
  unlockLabel?: string;
  reach?: "band" | "xp" | "xpWithFlirts" | "proposal" | "proposalCapped" | "enemy";
  reachAfter?: BondLevel;
  ask?: string;
};

export const BOND_LEVELS: Record<BondLevel, BondInfo> = {
  stranger: { level: 0, label: "คนแปลกหน้า", emoji: "👋", reach: "band" },
  acquaintance: { level: 1, label: "คนรู้จัก", emoji: "🤝", unlockLabel: "Acquaintance", reach: "xp" },
  friend: { level: 2, label: "เพื่อน", emoji: "🙂", unlockLabel: "Friend", reach: "xp" },
  close_friend: { level: 3, label: "เพื่อนสนิท", emoji: "🤗", unlockLabel: "Close Friend", reach: "xp" },
  crush: { level: 4, label: "แอบชอบ", emoji: "💗", unlockLabel: "Crush", reach: "xpWithFlirts" },
  lover: { level: 5, label: "คนรัก", emoji: "❤️", unlockLabel: "Lover", reach: "proposal", reachAfter: "crush", ask: "ขอคบ" },
  soulmate: { level: 6, label: "คู่แท้", emoji: "💞", unlockLabel: "Soulmate", reach: "proposal", reachAfter: "lover", ask: "ขอแต่งงาน" },
  enemy: { level: -1, label: "ศัตรู", emoji: "💢", jumpTo: "friend", reach: "enemy" },
  sibling: { level: 4, label: "พี่น้อง", emoji: "🌱", maxLevel: 4, unlockLabel: "Sibling", reach: "proposalCapped", ask: "ขอเป็นพี่น้อง" },
  family: { level: 4, label: "ครอบครัว", emoji: "🏠", maxLevel: 4, unlockLabel: "Family", reach: "proposalCapped", ask: "ขอเป็นครอบครัว" },
};

export const BOND_NAMES = Object.keys(BOND_LEVELS) as BondLevel[];
const ASCENDING: BondLevel[] = ["stranger", "acquaintance", "friend", "close_friend", "crush", "lover", "soulmate"];
const SPECIAL: BondLevel[] = ["sibling", "family", "enemy"];

export function isBond(value: unknown): value is BondLevel {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(BOND_LEVELS, value);
}
export function bondLevel(bond: string | null | undefined): number | null { return isBond(bond) ? BOND_LEVELS[bond].level : null; }
export function bondLabel(bond: string | null | undefined): string { return isBond(bond) ? BOND_LEVELS[bond].label : String(bond ?? ""); }
export function bondEmoji(bond: string | null | undefined): string { return isBond(bond) ? BOND_LEVELS[bond].emoji : ""; }
export function bondUnlockLabel(bond: string | null | undefined): string { return isBond(bond) ? (BOND_LEVELS[bond].unlockLabel ?? "") : ""; }
export function isBondUnlock(from: string | null | undefined, to: string | null | undefined): boolean {
  if (!isBond(to) || !BOND_LEVELS[to].unlockLabel) return false;
  if (!isBond(from)) return true;
  if (from === to) return false;
  return BOND_LEVELS[to].level >= BOND_LEVELS[from].level;
}
export function bondCeiling(bond: BondLevel): BondLevel {
  const info = BOND_LEVELS[bond];
  if (info.maxLevel === undefined) return "soulmate";
  return ASCENDING.find((name) => BOND_LEVELS[name].level === info.maxLevel) ?? bond;
}
export function bondRecoveryFrom(bond: string | null | undefined): BondLevel | null { return isBond(bond) ? (BOND_LEVELS[bond].jumpTo ?? null) : null; }

export function bondLadderText(): string {
  return [...ASCENDING, ...SPECIAL].map((name) => {
    const info = BOND_LEVELS[name];
    const notes: string[] = [];
    if (info.maxLevel !== undefined) notes.push(`ไปต่อได้ถึงระดับ ${info.maxLevel} เท่านั้น (ห้ามไปถึง lover)`);
    if (info.jumpTo) notes.push(`ถ้ากลับมาปกติต้องกระโดดไปที่ ${info.jumpTo} (ระดับ ${BOND_LEVELS[info.jumpTo].level}) เท่านั้น`);
    return `- ${name} (ระดับ ${info.level}) = ${info.label}${notes.length ? ` — ${notes.join("; ")}` : ""}`;
  }).join("\n");
}

export function xpBandRange(bond: "enemy" | "stranger" | "acquaintance" | "friend" | "close_friend"): string {
  switch (bond) {
    case "enemy": return `<= ${XP_THRESHOLDS[-1]}`;
    case "stranger": return `${XP_THRESHOLDS[-1] + 1}..${XP_THRESHOLDS[1] - 1}`;
    case "acquaintance": return `${XP_THRESHOLDS[1]}..${XP_THRESHOLDS[2] - 1}`;
    case "friend": return `${XP_THRESHOLDS[2]}..${XP_THRESHOLDS[3] - 1}`;
    case "close_friend": return `>= ${XP_THRESHOLDS[3]}`;
  }
}
export function xpBandsText(): string {
  return (["enemy", "stranger", "acquaintance", "friend", "close_friend"] as const).map((bond) => `${bond} ${xpBandRange(bond)}`).join(", ");
}
export function bondLadderWithThresholds(partner?: string | null): string {
  const who = partner?.trim() ? ` ${partner.trim()} ` : "";
  return [...ASCENDING, ...SPECIAL].map((name) => {
    const info = BOND_LEVELS[name];
    const head = `- ${name} (ระดับ ${info.level}) = ${info.label}`;
    switch (info.reach) {
      case "band": return `${head} — xp ${xpBandRange("stranger")}`;
      case "xp": return `${head} — xp >= ${XP_THRESHOLDS[info.level]}`;
      case "xpWithFlirts": return `${head} — xp >= ${CRUSH_XP_THRESHOLD} และ${who ? `${who}ถูก` : "ถูก"}จีบสะสม >= ${FLIRT_REQUIREMENT} ครั้ง`;
      case "proposal": return `${head} — ต้องเป็น ${info.reachAfter} ก่อน +${who || " อีกฝ่าย"}${info.ask} + Isla ตอบตกลง (xp >= ${PROPOSAL_XP})`;
      case "proposalCapped": {
        const above = ASCENDING.find((rung) => BOND_LEVELS[rung].level > (info.maxLevel ?? info.level));
        return `${head} — xp >= ${PROPOSAL_XP} + ${info.ask} + Isla ตอบตกลง${above ? ` (ไประดับ ${BOND_LEVELS[above].level} ไม่ได้)` : ""}`;
      }
      case "enemy": return `${head} — xp ${xpBandRange("enemy")}${info.jumpTo ? ` (กลับมาปกติต้องไปที่ ${info.jumpTo} เท่านั้น)` : ""}`;
      default: return head;
    }
  }).join("\n");
}

export const CRUSH_XP_THRESHOLD = 500;
export const XP_THRESHOLDS: Record<number, number> = { [-1]: -150, 0: -149, 1: 50, 2: 150, 3: 300, 4: CRUSH_XP_THRESHOLD, 5: 300, 6: 300 };
export const FLIRT_REQUIREMENT = 5;
export const FLIRT_XP_BONUS = 25;
const CAPPED: BondLevel[] = ["sibling", "family"];
export function isCappedBond(bond: BondLevel): boolean { return CAPPED.includes(bond); }
export function bondForXp(xp: number): BondLevel {
  if (xp <= XP_THRESHOLDS[-1]) return "enemy";
  if (xp < XP_THRESHOLDS[1]) return "stranger";
  if (xp < XP_THRESHOLDS[2]) return "acquaintance";
  if (xp < XP_THRESHOLDS[3]) return "friend";
  return "close_friend";
}

export type BondDerivation = { bond: BondLevel; xp: number; reason: string; changed: boolean; consumed: ApprovalName[] };
export type ApprovalName = "lover" | "soulmate" | "sibling" | "family";
export const PROPOSAL_XP = XP_THRESHOLDS[3];
export type BondSignals = { flirtCount: number; approvals?: Partial<Record<ApprovalName, boolean>> };

export function deriveBond(from: string | null | undefined, xp: number, signals: BondSignals): BondDerivation {
  const current: BondLevel = isBond(from) ? from : "stranger";
  const capped = isCappedBond(current);
  const approvals = signals.approvals ?? {};
  const enoughXp = xp >= PROPOSAL_XP;
  if (enoughXp) {
    if (approvals.family) return { bond: "family", xp, reason: `family accepted (xp ${xp})`, changed: current !== "family", consumed: ["family"] };
    if (approvals.sibling) return { bond: "sibling", xp, reason: `sibling accepted (xp ${xp})`, changed: current !== "sibling", consumed: ["sibling"] };
    if (!capped) {
      if (approvals.soulmate && current === "lover") return { bond: "soulmate", xp, reason: `marriage accepted while lover (xp ${xp})`, changed: true, consumed: ["soulmate"] };
      if (approvals.soulmate && current === "crush") return { bond: "lover", xp, reason: `marriage accepted while crush — grants lover first, soulmate stays pending (xp ${xp})`, changed: true, consumed: [] };
      if (approvals.lover && current === "crush") return { bond: "lover", xp, reason: `lover proposal accepted while crush (xp ${xp})`, changed: true, consumed: ["lover"] };
    }
  }
  const pending = (["family", "sibling", "soulmate", "lover"] as ApprovalName[]).filter((name) => approvals[name] && BOND_LEVELS[current].level < BOND_LEVELS[name].level);
  if (xp <= XP_THRESHOLDS[-1]) return { bond: "enemy", xp, reason: `xp ${xp} <= ${XP_THRESHOLDS[-1]}`, changed: current !== "enemy", consumed: [] };
  if (current === "enemy") { const jump = bondRecoveryFrom(current)!; return { bond: jump, xp, reason: `recovered from enemy — jumps to ${jump}`, changed: true, consumed: [] }; }
  const byXp = bondForXp(xp);
  const rank = BOND_LEVELS[byXp].level;
  const keep = BOND_LEVELS[current].level;
  let bond: BondLevel = current;
  let reason = `xp ${xp} supports level ${rank}, keeping ${current}`;
  if (rank > keep) { bond = byXp; reason = `xp ${xp} reached level ${rank}`; }
  else if (rank < keep && keep <= 3) { bond = rank === 0 ? "friend" : byXp; reason = rank === 0 ? `xp ${xp} is below the friend band, but stranger is not a fallback` : `xp ${xp} fell back to level ${rank}`; }
  if (capped && BOND_LEVELS[bond].level < 4) { bond = "close_friend"; reason += " — capped rung cannot climb"; }
  if (bond === "close_friend" && BOND_LEVELS[current].level < 4) {
    if (xp >= CRUSH_XP_THRESHOLD && signals.flirtCount >= FLIRT_REQUIREMENT) {
      bond = "crush";
      reason = `xp ${xp} + ${signals.flirtCount} accepted flirts (xp >= ${CRUSH_XP_THRESHOLD}, flirts >= ${FLIRT_REQUIREMENT})`;
    } else if (xp >= CRUSH_XP_THRESHOLD) {
      reason = `xp ${xp} reaches crush but only ${signals.flirtCount}/${FLIRT_REQUIREMENT} flirts`;
    } else {
      reason = `xp ${xp} is below crush threshold ${CRUSH_XP_THRESHOLD}`;
    }
  }
  if (pending.length) reason += ` — pending: ${pending.join(", ")}`;
  return { bond, xp, reason, changed: bond !== current, consumed: [] };
}
