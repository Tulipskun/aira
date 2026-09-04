import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "../config.js";

// Debug-only recorder for the exact Gemini request/response bodies. Payloads can contain
// conversation history, so keep only a small rolling window. GEMINI_DEBUG_PAYLOAD is ON by
// default; set it to 0/false/off/no to disable it.
export type DebugStage = "gemini1" | "gemini2";
export type DebugEvent = "request" | "response" | "error";
export type DebugContext = { userId?: string; userName?: string; turnId?: string };

type DumpRecord = {
  ts: string;
  stage: DebugStage;
  event: DebugEvent;
  model: string;
  attempt?: number;
  userId?: string;
  userName?: string;
  turnId?: string;
  payload?: unknown;
  response?: unknown;
  error?: { name?: string; status?: number; message: string };
};

const TRUTHY = new Set(["1", "true", "yes", "on"]);
const FALSY = new Set(["0", "false", "no", "off"]);
const MAX_RECORDS = 6; // request + response/error for the latest ~3 Gemini calls/turns.
const AUTO_TURN_TTL_MS = 10 * 60_000;
const activeTurns = new Map<string, { id: string; lastSeen: number }>();

export function debugDumpEnabled(): boolean {
  const raw = process.env.GEMINI_DEBUG_PAYLOAD;
  if (raw == null || raw.trim() === "") return true;
  const value = raw.trim().toLowerCase();
  if (FALSY.has(value)) return false;
  if (TRUTHY.has(value)) return true;
  return true;
}

function shortenSignature(signature: string): string {
  return `${signature.slice(0, 12)}…(${signature.length})`;
}

function redact(value: unknown, depth = 0): unknown {
  if (depth > 12) return "[truncated]";
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (/api[-_]?key|token|secret|authorization/i.test(key)) out[key] = "[redacted]";
    else if (key === "signature" && typeof item === "string") out[key] = shortenSignature(item);
    else out[key] = redact(item, depth + 1);
  }
  return out;
}

let warnedAt = 0;
function warnOnce(error: unknown): void {
  const now = Date.now();
  if (now - warnedAt < 60_000) return;
  warnedAt = now;
  console.error(`[DEBUG-DUMP] write failed (retrying after 60s): ${String(error)}`);
}

function dumpFile(): string {
  return process.env.GEMINI_DEBUG_PAYLOAD_FILE?.trim() || config.paths.geminiPayloadDump;
}

function turnKey(record: DumpRecord): string | null {
  return record.userId || record.userName || null;
}

function resolveTurnId(record: DumpRecord): string {
  if (record.turnId) return record.turnId;
  const key = turnKey(record);
  const now = Date.now();
  if (!key) return crypto.randomUUID();

  const active = activeTurns.get(key);
  const isNewTurn = record.stage === "gemini1" && record.event === "request" && (record.attempt ?? 1) === 1;
  if (!active || now - active.lastSeen > AUTO_TURN_TTL_MS || isNewTurn) {
    const id = crypto.randomUUID();
    activeTurns.set(key, { id, lastSeen: now });
    return id;
  }

  active.lastSeen = now;
  if (record.stage === "gemini2" && record.event === "response") activeTurns.delete(key);
  return active.id;
}

function withTurnId(record: DumpRecord): DumpRecord {
  const turnId = resolveTurnId(record);
  return { ...record, turnId };
}

function parseRecords(raw: string): unknown[] | null {
  const trimmed = raw.trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    // Recover legacy JSONL and a truncated JSON array.
  }
  if (trimmed.startsWith("[")) {
    const lines = trimmed.split("\n");
    for (let end = lines.length; end >= 1 && lines.length - end < 200; end--) {
      const body = lines.slice(0, end).join("\n").replace(/,\s*$/, "");
      try {
        const parsed = JSON.parse(`${body}\n]`);
        if (Array.isArray(parsed)) return parsed;
      } catch { /* keep recovering */ }
    }
    return null;
  }
  const records: unknown[] = [];
  for (const line of trimmed.split("\n")) {
    if (!line.trim()) continue;
    try { records.push(JSON.parse(line)); } catch { return null; }
  }
  return records;
}

function serialize(records: unknown[]): string {
  return records.length ? `[\n${records.map((record) => JSON.stringify(record)).join(",\n")}\n]\n` : "[\n]\n";
}

function readRecords(file: string): unknown[] {
  if (!existsSync(file)) return [];
  return parseRecords(readFileSync(file, "utf8")) as DumpRecord[] ?? [];
}

function writeRecords(file: string, records: unknown[]): void {
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true });
  const temp = `${file}.tmp-${process.pid}`;
  writeFileSync(temp, serialize(records));
  renameSync(temp, file);
}

function prepareFile(file: string): unknown[] {
  if (!existsSync(file)) {
    writeRecords(file, []);
    return [];
  }
  const raw = readFileSync(file, "utf8");
  const records = parseRecords(raw);
  if (records === null) {
    renameSync(file, `${file}.bak`);
    writeRecords(file, []);
    console.error(`[DEBUG-DUMP] unreadable dump moved to ${file}.bak; started a fresh array`);
    return [];
  }
  const canonical = serialize(records);
  if (raw !== canonical) writeFileSync(file, canonical);
  return records;
}

function appendRecord(file: string, record: DumpRecord): void {
  const records = prepareFile(file);
  records.push(record);
  // Each Gemini API call normally contributes request + response/error. Six records keeps the
  // latest three calls visible while preventing an ever-growing payload history.
  writeRecords(file, records.slice(-MAX_RECORDS));
}

export function debugDump(record: DumpRecord): void {
  if (!debugDumpEnabled()) return;
  try {
    appendRecord(dumpFile(), redact(withTurnId(record)) as DumpRecord);
  } catch (error) {
    warnOnce(error);
  }
}

export function readDebugDump(file: string = dumpFile()): DumpRecord[] {
  return readRecords(file) as DumpRecord[];
}

export function migrateDebugDumpFile(file: string = dumpFile()): { records: number; changed: boolean } {
  const existed = existsSync(file);
  const before = existed ? readFileSync(file, "utf8") : "";
  const records = prepareFile(file);
  const after = readFileSync(file, "utf8");
  return { records: records.length, changed: before !== after };
}
