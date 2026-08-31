/**
 * Gemini 2's reply format — the relationship state of one turn, as JSON.
 *
 * Gemini 2 used to answer with a tool call (`execute` with an `operations` array). It now answers
 * with one flat JSON object, exactly like Gemini 1, so both stages share one parsing path and one
 * failure mode.
 *
 * The important design rule: **Gemini 2 never names a bond.** It reports facts about the turn —
 * how much the relationship moved (`affinity`), whether the user flirted (`is_flirt`), whether *she*
 * accepted a proposal (`approve_lover` / `approve_soulmate` / …) — and `deriveBond()` in `sql/bonds.ts`
 * turns those facts plus the stored xp into a rung on the ladder. A model that cannot set the rung
 * cannot skip the ladder's prerequisites either.
 *
 * Some fields are only meaningful at certain rungs (`approve_lover` means nothing to a stranger), so
 * the JSON schema cannot demand them unconditionally — a schema is one static object while the
 * requirement depends on the user's current bond. `requiredFieldsFor()` states the rule, the prompt
 * teaches it, and `parseIslaState()` treats a missing field as `false` and says so.
 *
 * Parsing never throws and never loses the turn: a malformed reply means "no state change this
 * turn", which is recoverable, whereas throwing costs the user their answer.
 */

import type { BondLevel } from "../sql/bonds.js";
import { imageNames, isKnownImage, normalizeImageName } from "../bot/images.js";

/** What the model answers when no picture fits this turn. Not a filename. */
export const NO_IMAGE = "none";

/**
 * Isla's expression images, offered to Gemini 2 as the `select_image` enum.
 *
 * **The `images/` directory is the list** (see `bot/images.ts`) — there used to be a hardcoded
 * array of invented names here (`neutral`, `happy`, `shy_smile`, …) that matched no file on disk,
 * so the model could only ever pick a picture that failed to load, and adding artwork changed
 * nothing. Dropping a file into `images/` now makes it offerable with no code edit.
 *
 * `imageChoices()` is the live read; `IMAGES` is the boot-time snapshot, kept because tests and
 * callers want a plain array. The schema uses the getter so the enum handed to the API always
 * agrees with the catalog printed in Gemini 2's system prompt — both are re-read per request, and
 * both produce the same string until somebody actually adds a picture, so the prompt cache is not
 * disturbed by the liveness.
 */
export function imageChoices(dir?: string): string[] {
  return [...imageNames(dir), NO_IMAGE];
}

export const IMAGES: readonly string[] = imageChoices();

export type ImageName = string;

export const AFFINITY_MIN = -100;
export const AFFINITY_MAX = 100;
/**
 * The floor for any interaction that is not negative.
 *
 * The owner's rule: a normal turn is worth at least +10. Without a floor the model drifts to
 * awarding 0 for "nothing happened", and a relationship that never moves never climbs the ladder.
 */
export const AFFINITY_NEUTRAL_FLOOR = 10;

/**
 * What Gemini 2 must report about one turn.
 *
 * `bond` is deliberately absent — see the module comment.
 */
export type IslaState = {
  /** Change in relationship points this turn, -100..100. Stored as `xp`. */
  affinity: number;
  /** Present only when the user's rung can be romantic (see `requiresFlirtFlag`). */
  isFlirt?: boolean;
  /** Isla accepted a request to be lovers. Only consulted while the user is a `crush`. */
  approveLover?: boolean;
  /** Isla accepted a marriage proposal. Only consulted while the user is a `lover`. */
  approveSoulmate?: boolean;
  /** Isla accepted a request to be siblings. Only consulted from level 2 up. */
  approveSibling?: boolean;
  /** Isla accepted a request to be family. Only consulted from level 2 up. */
  approveFamily?: boolean;
  /** Empty means "no image this turn" — a legitimate answer, not a failure. */
  selectImage: string;
  addFacts: string[];
  /** Nicknames Isla gave the user in her reply this turn. Shown in the embed footer. */
  addNicknames: string[];
  /** Empty means nothing worth keeping long-term. */
  ingestMemory: string;
  /** The reply was usable JSON matching the shape above. */
  parsed: boolean;
  /** What had to be repaired or ignored while reading the reply. */
  warnings: string[];
};

/**
 * The bond names this parser needs to know about.
 *
 * Type-only import, so there is no runtime dependency from `gemini/` on `sql/` — but the two can no
 * longer drift, which a hand-copied union would have allowed.
 */
export type BondName = BondLevel;

/**
 * The JSON schema handed to the API.
 *
 * Only `affinity` and `select_image` are hard-required: every other field's meaning depends on the
 * user's current rung, which the schema cannot see.
 */
export const ISLA_STATE_SCHEMA = {
  type: "object",
  properties: {
    affinity: {
      type: "number",
      description:
        "ค่าความสัมพันธ์ที่เปลี่ยนในเทิร์นนี้ (-100 ถึง 100) — ยิ่งบวกยิ่งสนิท, ติดลบเมื่อแย่ลง " +
        `การคุยปกติ/ไม่ใช่ด้านลบต้องได้อย่างน้อย +${AFFINITY_NEUTRAL_FLOOR}; ` +
        "ด้านลบเล็กน้อย -1..-9; ด่า/ทำร้ายความรู้สึก -10..-40; หยาบคายมาก/ดูถูกซ้ำ ๆ -41..-100",
    },
    is_flirt: {
      type: "boolean",
      description:
        "true เมื่อผู้ใช้จีบ/พูดหวาน/เข้าหาเชิงชู้สาว, false เมื่อไม่ใช่ — จำเป็นเมื่อผู้ใช้ยังอยู่ในระดับที่พัฒนาเป็นแฟนได้",
    },
    approve_lover: {
      type: "boolean",
      description: "true เมื่อผู้ใช้ขอคบ/ขอเป็นแฟน และ **ไอล่าตอบตกลง** ในข้อความของเทิร์นนี้ — จำเป็นเมื่อระดับคือ crush",
    },
    approve_soulmate: {
      type: "boolean",
      description: "true เมื่อผู้ใช้ขอแต่งงาน และ **ไอล่าตอบตกลง** ในข้อความของเทิร์นนี้ — จำเป็นเมื่อระดับคือ lover",
    },
    approve_sibling: {
      type: "boolean",
      description: "true เมื่อผู้ใช้ขอเป็นพี่น้อง และ **ไอล่าตอบตกลง** ในข้อความของเทิร์นนี้",
    },
    approve_family: {
      type: "boolean",
      description: "true เมื่อผู้ใช้ขอเป็นคนในครอบครัว และ **ไอล่าตอบตกลง** ในข้อความของเทิร์นนี้",
    },
    select_image: {
      type: "string",
      // A getter, not a snapshot: the enum must never disagree with the file list in the prompt.
      get enum() {
        return imageChoices();
      },
      description:
        "ไฟล์รูปอารมณ์ของไอล่าที่ตรงกับข้อความของเธอที่สุดในเทิร์นนี้ ต้องเป็นชื่อไฟล์ที่ระบุไว้ในรายการเท่านั้น " +
        `(รวม "${NO_IMAGE}" เมื่อไม่มีรูปไหนเข้ากับอารมณ์ของเธอจริง ๆ — ดีกว่าส่งรูปผิด)`,
    },
    add_facts: {
      type: "array",
      items: { type: "string" },
      description: "ข้อเท็จจริงเกี่ยวกับผู้ใช้โดยตรง (ชื่อ, อายุ, การเรียน, งาน, ครอบครัว, ความชอบ, นิสัย) — ไม่เกิน 3 ข้อต่อเทิร์น",
    },
    add_nicknames: {
      type: "array",
      items: { type: "string" },
      description:
        "ฉายาที่ไอล่าเพิ่งตั้งให้ผู้ใช้ในข้อความของเทิร์นนี้ (คำสั้น ๆ ไม่มีเครื่องหมาย #) — " +
        "ใส่เฉพาะที่เธอเรียกจริงในคำตอบของเธอ ถ้าไม่มีให้ส่งค่าว่าง []",
    },
    ingest_memory: {
      type: "string",
      description: "ความทรงจำที่ควรเก็บระยะยาว (เหตุการณ์สำคัญ, การสารภาพ, การขอโทษ, ความลับ, เรื่องสะเทือนใจ) — ไม่มีให้ส่งค่าว่าง",
    },
  },
  required: ["affinity", "select_image"],
} as const;

/**
 * Which fields the model must answer for a user at `bond`.
 *
 * Exported so the prompt block and the parser agree on one rule instead of restating it twice — the
 * bug class this whole file exists to avoid is a required field nobody enforces.
 */
export function requiredFieldsFor(bond: BondName | string | null | undefined): (keyof IslaState)[] {
  const fields: (keyof IslaState)[] = ["affinity", "selectImage"];
  if (romanticallyAvailable(bond)) fields.push("isFlirt");
  if (bond === "crush") fields.push("approveLover");
  if (bond === "lover") fields.push("approveSoulmate");
  return fields;
}

/**
 * Can this rung still become romantic?
 *
 * `enemy` (level -1), `sibling` and `family` cannot, so flirt detection is pointless there and the
 * model is not asked. Everything else — including `stranger` — can.
 */
export function romanticallyAvailable(bond: BondName | string | null | undefined): boolean {
  return bond !== "enemy" && bond !== "sibling" && bond !== "family";
}

/** Keys accepted for each field, so a model that drifts on naming still gets read correctly. */
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

/**
 * The first value present among `keys`, keeping the JSON type intact.
 *
 * Booleans must not be flattened to strings here — `is_flirt: false` is a real answer and `"false"`
 * would read as true.
 */
function pickValue(record: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    const value = record[key];
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

/** Read a JSON object out of a reply, tolerating prose and code fences. */
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
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
              return parsed as Record<string, unknown>;
            }
          } catch {
            /* keep looking */
          }
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
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function asStringList(value: unknown): string[] {
  const out: string[] = [];
  const push = (item: unknown) => {
    // Strings and `{text}` objects only. A bare number or null is not a fact — `String(7)` would
    // store "7" as something Isla believes about the user.
    if (typeof item === "string") {
      const text = item.trim();
      if (text) out.push(text);
    } else if (item && typeof item === "object" && !Array.isArray(item)) {
      const text = (item as Record<string, unknown>).text;
      if (typeof text === "string" && text.trim()) out.push(text.trim());
    }
  };
  if (Array.isArray(value)) for (const item of value) push(item);
  else push(value);
  return out;
}

/**
 * Read Gemini 2's reply into an `IslaState`.
 *
 * `bond` is the user's rung **before** this turn, which is what decides the required fields. A reply
 * that is not JSON at all yields `parsed: false` and an all-default state, so the caller can log it
 * and carry on with the user's answer already sent.
 */
export function parseIslaState(raw: string, bond: BondName | string | null | undefined): IslaState {
  const warnings: string[] = [];
  const text = (raw ?? "").trim();
  if (!text) {
    return {
      affinity: 0,
      selectImage: "",
      addFacts: [],
      addNicknames: [],
      ingestMemory: "",
      parsed: false,
      warnings: ["empty reply"],
    };
  }

  const record = extractJsonObject(text);
  if (!record) {
    return {
      affinity: 0,
      selectImage: "",
      addFacts: [],
      addNicknames: [],
      ingestMemory: "",
      parsed: false,
      warnings: ["reply was not JSON"],
    };
  }

  const read = (field: keyof typeof FIELD_KEYS) => pickValue(record, FIELD_KEYS[field]);

  // --- affinity ---
  const rawAffinity = asNumber(read("affinity"));
  let affinity = 0;
  if (rawAffinity === undefined) {
    warnings.push(`missing affinity -- no relationship change this turn`);
  } else {
    affinity = Math.round(rawAffinity);
    if (affinity > AFFINITY_MAX) {
      affinity = AFFINITY_MAX;
      warnings.push(`affinity ${rawAffinity} clamped to ${AFFINITY_MAX}`);
    } else if (affinity < AFFINITY_MIN) {
      affinity = AFFINITY_MIN;
      warnings.push(`affinity ${rawAffinity} clamped to ${AFFINITY_MIN}`);
    } else if (affinity > 0 && affinity < AFFINITY_NEUTRAL_FLOOR) {
      // The owner's floor: anything not negative is worth at least +10. Raised quietly — it is the
      // rule, not an anomaly, and logging every normal turn would bury the warnings that matter.
      affinity = AFFINITY_NEUTRAL_FLOOR;
    }
  }

  const state: IslaState = { affinity, selectImage: "", addFacts: [], addNicknames: [], ingestMemory: "", parsed: true, warnings };

  // --- is_flirt: only asked when the rung can still turn romantic ---
  if (romanticallyAvailable(bond)) {
    const value = asBoolean(read("isFlirt"));
    if (value === undefined) {
      state.isFlirt = false;
      warnings.push(`missing is_flirt at bond "${bond ?? "stranger"}" -- treated as false`);
    } else {
      state.isFlirt = value;
    }
  } else if (asBoolean(read("isFlirt")) === true) {
    warnings.push(`is_flirt ignored at bond "${bond}" -- this rung cannot become romantic`);
  }

  // --- approvals: each one only means something at one rung ---
  // Typed as the four boolean fields, not `keyof IslaState`: writing through the wider union asks
  // for the intersection of every value type (string[] & number & ... = never) and rejects `true`.
  type ApprovalField = "approveLover" | "approveSoulmate" | "approveSibling" | "approveFamily";
  const approvals: [ApprovalField, string, BondName | null][] = [
    ["approveLover", "approve_lover", "crush"],
    ["approveSoulmate", "approve_soulmate", "lover"],
    ["approveSibling", "approve_sibling", null],
    ["approveFamily", "approve_family", null],
  ];
  for (const [field, name, requiredAt] of approvals) {
    const value = asBoolean(read(field));
    if (requiredAt === null || bond !== requiredAt) {
      // Outside its rung the answer is not needed; record it only when the model volunteered a yes,
      // because that is a real acceptance of a real request and the ladder still has to honour it.
      if (value === true) state[field] = true;
      continue;
    }
    if (value === undefined) {
      state[field] = false;
      warnings.push(`missing ${name} at bond "${bond}" -- treated as false`);
    } else {
      state[field] = value;
    }
  }

  // --- select_image ---
  // Validated against the `images/` directory, not against a list copied into this file. The model
  // may answer with a path prefix (`images/foo.jpg`) or with `none`; both are normal answers, and
  // only a name that has no file behind it is a warning.
  const rawImage = read("selectImage");
  const image = typeof rawImage === "string" ? normalizeImageName(rawImage) : rawImage === undefined ? "" : normalizeImageName(String(rawImage));
  if (!image || image.toLowerCase() === NO_IMAGE) {
    // `none` is the model exercising its opt-out; an absent field is drift. Both mean "no picture",
    // but only the second is worth a warning.
    if (!image) warnings.push("no select_image -- no image this turn");
  } else if (!isKnownImage(image)) {
    warnings.push(`unknown select_image "${image}" -- no image this turn`);
  } else {
    state.selectImage = image;
  }

  state.addFacts = asStringList(read("addFacts"));
  state.addNicknames = asStringList(read("addNicknames"));
  const memory = read("ingestMemory");
  state.ingestMemory = typeof memory === "string" ? memory.trim() : memory === undefined ? "" : String(memory).trim();

  return state;
}
