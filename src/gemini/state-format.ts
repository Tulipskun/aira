/**
 * Gemini 2's reply format — the relationship state of one turn, as JSON.
 *
 * Gemini 2 is a post-response analyzer. It reports relationship signals and fact proposals; the
 * application remains the final authorization boundary for personal-fact writes.
 */
import type { BondLevel } from "../sql/bonds.js";
import { imageNames, isKnownImage, normalizeImageName } from "../bot/images.js";

export const NO_IMAGE = "none";

export function imageChoices(dir?: string): string[] {
  return [...imageNames(dir), NO_IMAGE];
}

export const IMAGES: readonly string[] = imageChoices();
export type ImageName = string;

export const AFFINITY_MIN = -100;
export const AFFINITY_MAX = 100;
export const AFFINITY_NEUTRAL_FLOOR = 10;

export type AffinityTier = { min: number; max: number; label: string };
export const AFFINITY_TIERS: readonly AffinityTier[] = [
  { min: AFFINITY_NEUTRAL_FLOOR, max: AFFINITY_MAX, label: "การคุยปกติ/ไม่ใช่ด้านลบ" },
  { min: -9, max: -1, label: "ด้านลบเล็กน้อย" },
  { min: -40, max: -10, label: "ด่า/ทำร้ายความรู้สึก" },
  { min: AFFINITY_MIN, max: -41, label: "หยาบคายมาก/ดูถูกซ้ำ ๆ" },
];

function signed(value: number): string { return value > 0 ? `+${value}` : String(value); }
export function affinityScaleText(separator = "; "): string {
  return AFFINITY_TIERS.map((tier) => `${tier.label} ${signed(tier.min)}..${signed(tier.max)}`).join(separator);
}

export const FACTS_PER_TURN = 3;

export type FactProposal = {
  text: string;
  ownerUserId: string;
  confirmedByOwner: boolean;
  replacesFact?: string;
};

export type IslaState = {
  affinity: number;
  isFlirt?: boolean;
  approveLover?: boolean;
  approveSoulmate?: boolean;
  approveSibling?: boolean;
  approveFamily?: boolean;
  selectImage: string;
  addFacts: FactProposal[];
  addNicknames: string[];
  ingestMemory: string;
  parsed: boolean;
  warnings: string[];
};

export type BondName = BondLevel;

export const ISLA_STATE_SCHEMA = {
  type: "object",
  properties: {
    affinity: {
      type: "number",
      description:
        `คะแนนความสัมพันธ์ที่เปลี่ยนในเทิร์นนี้ (${AFFINITY_MIN} ถึง ${AFFINITY_MAX}) — ค่าบวกคือความสัมพันธ์ดีขึ้น ค่าลบคือแย่ลง ` +
        `ช่วงคะแนน: ${affinityScaleText()}.`,
    },
    is_flirt: { type: "boolean", description: "true เมื่อ {{partner}} เป็นฝ่ายจีบหรือเข้าหาเชิงชู้สาวในเทิร์นนี้" },
    approve_lover: { type: "boolean", description: "true เมื่อทั้งสองฝ่ายยินยอมเป็นคนรักกันอย่างชัดเจนในเทิร์นนี้" },
    approve_soulmate: { type: "boolean", description: "true เมื่อทั้งสองฝ่ายยินยอมแต่งงานกันอย่างชัดเจนในเทิร์นนี้" },
    approve_sibling: { type: "boolean", description: "true เมื่อทั้งสองฝ่ายยินยอมเป็นพี่น้องกันอย่างชัดเจนในเทิร์นนี้" },
    approve_family: { type: "boolean", description: "true เมื่อทั้งสองฝ่ายยินยอมให้ความสัมพันธ์เป็นครอบครัวอย่างชัดเจนในเทิร์นนี้" },
    select_image: {
      type: "string",
      get enum() { return imageChoices(); },
      description: `ชื่อไฟล์รูปอารมณ์ของไอล่าที่ตรงกับคำตอบของเธอที่สุด (ใช้ "${NO_IMAGE}" เมื่อไม่มีรูปที่เหมาะสม)`,
    },
    add_facts: {
      type: "array",
      items: {
        type: "object",
        properties: {
          text: { type: "string", description: "ข้อเท็จจริงที่เป็นของบุคคลนี้" },
          owner_user_id: { type: "string", description: "userId ของเจ้าของข้อเท็จจริง ไม่ใช่ session key และไม่ใช่ชื่อที่คาดเดา" },
          confirmed_by_owner: { type: "boolean", description: "true เฉพาะเมื่อเจ้าของข้อเท็จจริงยืนยันข้อมูลนี้ด้วยตนเองในบริบทที่วิเคราะห์" },
          replaces_fact: { type: "string", description: "ข้อเท็จจริงเดิมที่ข้อความนี้ยืนยันว่าแทนที่; ว่างหากไม่ใช่การแทนที่" },
        },
        required: ["text", "owner_user_id", "confirmed_by_owner"],
      },
      description: `ข้อเสนอข้อเท็จจริงไม่เกิน ${FACTS_PER_TURN} ข้อ; ข้อความของบุคคลอื่นห้ามเปลี่ยนข้อเท็จจริงของเขาโดยไม่มีการยืนยันจากเจ้าของ`,
    },
    add_nicknames: { type: "array", items: { type: "string" }, description: "ฉายาใหม่ที่ไอล่าใช้เรียก {{partner}} จริงในคำตอบเทิร์นนี้" },
    ingest_memory: { type: "string", description: "เหตุการณ์สำคัญจากเทิร์นนี้ที่ควรเก็บเป็นความทรงจำระยะยาว" },
  },
  required: ["affinity", "select_image"],
} as const;

export function requiredFieldsFor(bond: BondName | string | null | undefined): (keyof IslaState)[] {
  const fields: (keyof IslaState)[] = ["affinity", "selectImage"];
  if (romanticallyAvailable(bond)) fields.push("isFlirt");
  if (bond === "crush") fields.push("approveLover");
  if (bond === "lover") fields.push("approveSoulmate");
  return fields;
}

export function romanticallyAvailable(bond: BondName | string | null | undefined): boolean {
  return bond !== "enemy" && bond !== "sibling" && bond !== "family";
}

const FIELD_KEYS: Record<string, string[]> = {
  affinity: ["affinity", "xp", "delta", "relationship", "relation"],
  isFlirt: ["is_flirt", "isFlirt", "flirt", "flirtatious"],
  approveLover: ["approve_lover", "approveLover", "lover_accepted", "accept_lover"],
  approveSoulmate: ["approve_soulmate", "approveSoulmate", "soulmate_accepted", "accept_soulmate"],
  approveSibling: ["approve_sibling", "approveSibling", "sibling_accepted", "accept_sibling"],
  approveFamily: ["approve_family", "approveFamily", "family_accepted", "accept_family"],
  selectImage: ["select_image", "selectImage", "image", "expression"],
  addFacts: ["add_facts", "addFacts", "facts"],
  addNicknames: ["add_nicknames", "addNicknames", "nicknames", "nickname"],
  ingestMemory: ["ingest_memory", "ingestMemory", "memory"],
};

function pickValue(record: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    const value = record[key];
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

function extractJsonObject(text: string): Record<string, unknown> | null {
  const candidates: string[] = [];
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fenced?.[1]) candidates.push(fenced[1]);
  candidates.push(text);
  for (const source of candidates) {
    const start = source.indexOf("{");
    if (start === -1) continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < source.length; i++) {
      const char = source[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') inString = true;
      else if (char === "{") depth++;
      else if (char === "}") {
        depth--;
        if (depth === 0) {
          try {
            const parsed = JSON.parse(source.slice(start, i + 1));
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
          } catch {}
        }
      }
    }
  }
  return null;
}

function asBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const text = value.trim().toLowerCase();
    if (["true", "yes", "ya", "1", "ตกลง", "ใช่", "ครับ", "ค่ะ"].includes(text)) return true;
    if (["false", "no", "0", "ไม่ใช่", "ไม่", "ปฎิเสธ", "ปฏิเสธ"].includes(text)) return false;
  }
  return undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") { const parsed = Number(value); if (Number.isFinite(parsed)) return parsed; }
  return undefined;
}

function asStringList(value: unknown): string[] {
  const out: string[] = [];
  const push = (item: unknown) => {
    if (typeof item === "string") { const text = item.trim(); if (text) out.push(text); }
    else if (item && typeof item === "object" && !Array.isArray(item)) {
      const text = (item as Record<string, unknown>).text;
      if (typeof text === "string" && text.trim()) out.push(text.trim());
    }
  };
  if (Array.isArray(value)) for (const item of value) push(item); else push(value);
  return out;
}

function asFactProposals(value: unknown, warnings: string[]): FactProposal[] {
  if (!Array.isArray(value)) return [];
  const out: FactProposal[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      warnings.push("invalid fact proposal ignored");
      continue;
    }
    const record = item as Record<string, unknown>;
    const text = typeof record.text === "string" ? record.text.trim() : "";
    const ownerUserId = typeof record.owner_user_id === "string" ? record.owner_user_id.trim() : "";
    const confirmedByOwner = asBoolean(record.confirmed_by_owner);
    const replacesFact = typeof record.replaces_fact === "string" ? record.replaces_fact.trim() : "";
    if (!text || !ownerUserId || confirmedByOwner === undefined) {
      warnings.push("fact proposal missing text, owner_user_id, or confirmed_by_owner -- ignored");
      continue;
    }
    out.push({ text, ownerUserId, confirmedByOwner, ...(replacesFact ? { replacesFact } : {}) });
  }
  return out;
}

export function parseIslaState(raw: string, bond: BondName | string | null | undefined): IslaState {
  const warnings: string[] = [];
  const text = (raw ?? "").trim();
  if (!text) return { affinity: 0, selectImage: "", addFacts: [], addNicknames: [], ingestMemory: "", parsed: false, warnings: ["empty reply"] };
  const record = extractJsonObject(text);
  if (!record) return { affinity: 0, selectImage: "", addFacts: [], addNicknames: [], ingestMemory: "", parsed: false, warnings: ["reply was not JSON"] };
  const read = (field: keyof typeof FIELD_KEYS) => pickValue(record, FIELD_KEYS[field]);

  const rawAffinity = asNumber(read("affinity"));
  let affinity = 0;
  if (rawAffinity === undefined) warnings.push("missing affinity -- no relationship change this turn");
  else {
    affinity = Math.round(rawAffinity);
    if (affinity > AFFINITY_MAX) { affinity = AFFINITY_MAX; warnings.push(`affinity ${rawAffinity} clamped to ${AFFINITY_MAX}`); }
    else if (affinity < AFFINITY_MIN) { affinity = AFFINITY_MIN; warnings.push(`affinity ${rawAffinity} clamped to ${AFFINITY_MIN}`); }
    else if (affinity > 0 && affinity < AFFINITY_NEUTRAL_FLOOR) affinity = AFFINITY_NEUTRAL_FLOOR;
  }

  const state: IslaState = { affinity, selectImage: "", addFacts: asFactProposals(read("addFacts"), warnings), addNicknames: [], ingestMemory: "", parsed: true, warnings };

  if (romanticallyAvailable(bond)) {
    const value = asBoolean(read("isFlirt"));
    state.isFlirt = value === undefined ? false : value;
    if (value === undefined) warnings.push(`missing is_flirt at bond "${bond ?? "stranger"}" -- treated as false`);
  } else if (asBoolean(read("isFlirt")) === true) warnings.push(`is_flirt ignored at bond "${bond}" -- this rung cannot become romantic`);

  type ApprovalField = "approveLover" | "approveSoulmate" | "approveSibling" | "approveFamily";
  const approvals: [ApprovalField, string, BondName | null][] = [
    ["approveLover", "approve_lover", "crush"], ["approveSoulmate", "approve_soulmate", "lover"], ["approveSibling", "approve_sibling", null], ["approveFamily", "approve_family", null],
  ];
  for (const [field, name, requiredAt] of approvals) {
    const value = asBoolean(read(field));
    if (requiredAt === null || bond !== requiredAt) { if (value === true) state[field] = true; continue; }
    state[field] = value === true;
    if (value === undefined) warnings.push(`missing ${name} at bond "${bond}" -- treated as false`);
  }

  const rawImage = read("selectImage");
  const image = typeof rawImage === "string" ? normalizeImageName(rawImage) : rawImage === undefined ? "" : normalizeImageName(String(rawImage));
  if (!image || image.toLowerCase() === NO_IMAGE) { if (!image) warnings.push("no select_image -- no image this turn"); }
  else if (!isKnownImage(image)) warnings.push(`unknown select_image "${image}" -- no image this turn`);
  else state.selectImage = image;

  state.addNicknames = asStringList(read("addNicknames"));
  const memory = read("ingestMemory");
  state.ingestMemory = typeof memory === "string" ? memory.trim() : memory === undefined ? "" : String(memory).trim();
  return state;
}
