import {
  closeSync,
  existsSync,
  fstatSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readSync,
  readFileSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";
import { config } from "../config.js";

// Debug-only recorder for the exact bodies the Gemini Interactions API sees. The bot's real
// request payload is otherwise invisible (nothing logs it, and the pipeline rebuilds it from
// SQLite + Chroma on every turn), so reproducing "why did she answer like that" meant
// reconstructing it by hand.
//
// The file is ONE JSON ARRAY -- `[{...},\n {...}\n]` -- so `JSON.parse(readFileSync(f))` and
// `json.load(open(f))` work on the whole file. It used to be JSONL (one object per line), which
// parsed only the first record before dying on "Extra data". Records still stay one-per-line, so
// `tail -f`, `grep` and line-based tools keep working.
//
// Staying valid *while the bot runs* means inserting each record before the closing bracket
// instead of appending to EOF: locate the trailing `]`, write `,` + record + `]` there, then
// truncate. That is O(1) per record -- no rewriting the whole file (it grows to megabytes).
//
// OFF BY DEFAULT. Toggle with GEMINI_DEBUG_PAYLOAD=1 (also accepts true/yes/on). The env var is
// read on *every* call rather than cached at module load, so flipping it in .env and restarting
// -- or clearing it in the shell -- takes effect immediately with no code change.
//
// Output lands under .aira/ which is gitignored: the dumps contain full conversation history
// (PII), so never commit them and never point GEMINI_DEBUG_PAYLOAD_FILE outside .aira/.

export type DebugStage = "gemini1" | "gemini2";
export type DebugEvent = "request" | "response" | "error";
// Who the call belongs to. The stage itself is derived from responseMode in client.ts, so
// callers only pass identity.
export type DebugContext = { userId?: string; userName?: string };

type DumpRecord = {
  ts: string;
  stage: DebugStage;
  event: DebugEvent;
  model: string;
  attempt?: number;
  userId?: string;
  userName?: string;
  payload?: unknown;
  response?: unknown;
  error?: { name?: string; status?: number; message: string };
};

const TRUTHY = new Set(["1", "true", "yes", "on"]);

export function debugDumpEnabled(): boolean {
  const value = process.env.GEMINI_DEBUG_PAYLOAD ?? "";
  return TRUTHY.has(value.trim().toLowerCase());
}

// Thought signatures are long opaque blobs; a prefix plus length is enough to tell rotated ones
// apart, and it keeps the dump readable.
function shortenSignature(signature: string): string {
  return `${signature.slice(0, 12)}…(${signature.length})`;
}

function redact(value: unknown, depth = 0): unknown {
  if (depth > 12) return "[truncated]";
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (/api[-_]?key|token|secret|authorization/i.test(key)) {
      out[key] = "[redacted]";
    } else if (key === "signature" && typeof item === "string") {
      out[key] = shortenSignature(item);
    } else {
      out[key] = redact(item, depth + 1);
    }
  }
  return out;
}

let warned = 0;
function warnOnce(error: unknown): void {
  const now = Date.now();
  if (now - warned < 60_000) return;
  warned = now;
  console.error(`[DEBUG-DUMP] write failed (retrying after 60s): ${String(error)}`);
}

// Created lazily and re-created when the target directory changes, so pointing
// GEMINI_DEBUG_PAYLOAD_FILE somewhere else at runtime still works.
let readyDir = "";

function dumpFile(): string {
  return process.env.GEMINI_DEBUG_PAYLOAD_FILE?.trim() || config.paths.geminiPayloadDump;
}

const ARRAY_OPEN = "[\n";
const ARRAY_CLOSE = "\n]\n";
const EMPTY_ARRAY = "[\n]\n";
const NEWLINE = 0x0a;
const SPACE = 0x20;
const CLOSE_BRACKET = 0x5d;

/**
 * Read a dump file in any of its historical shapes and return the records it holds.
 * Handles: a proper JSON array (current format), a single bare object, and the old
 * JSONL format (one object per line). Returns null when nothing parses, so the caller
 * can preserve the unreadable file instead of overwriting it.
 */
function parseRecords(raw: string): unknown[] | null {
  const trimmed = raw.trim();
  if (!trimmed) return [];
  try {
    const whole = JSON.parse(trimmed);
    return Array.isArray(whole) ? whole : [whole];
  } catch {
    /* fall through to recovery / line-by-line */
  }
  // A truncated array -- the process died mid-write, so the closing ']' (and possibly the last
  // record) is missing. Walk back over whole records until one closes cleanly. This keeps every
  // intact record and drops only the torn tail. Bounded so a pathological file stays cheap.
  if (trimmed.startsWith("[")) {
    const lines = trimmed.split("\n");
    // Start by trusting every line (the tail may simply be the missing ']'), then walk back.
    for (let end = lines.length, tries = 0; end >= 1 && tries < 200; end -= 1, tries += 1) {
      // Drop a dangling comma left by the cut record, otherwise the candidate never closes.
      const body = lines.slice(0, end).join("\n").replace(/,\s*$/, "");
      const candidate = `${body}\n]`;
      if (!candidate.includes("{")) continue;
      try {
        const parsed = JSON.parse(candidate);
        if (Array.isArray(parsed)) return parsed;
      } catch {
        /* keep walking back */
      }
    }
    return null;
  }
  const out: unknown[] = [];
  for (const line of trimmed.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      return null;
    }
  }
  return out;
}

function serializeRecords(records: unknown[]): string {
  if (records.length === 0) return EMPTY_ARRAY;
  return ARRAY_OPEN + records.map((r) => JSON.stringify(r)).join(",\n") + ARRAY_CLOSE;
}

/**
 * Make sure the file exists and is a well-formed JSON array in the canonical layout,
 * migrating JSONL dumps from earlier builds in place. Records are never dropped: if a
 * file cannot be parsed at all it is moved aside to `<file>.bak` and we start fresh.
 */
let preparedFile = "";
function prepareArrayFile(file: string): void {
  if (preparedFile === file) return;
  if (!existsSync(file)) {
    writeFileSync(file, EMPTY_ARRAY);
    preparedFile = file;
    return;
  }
  const raw = readFileSync(file, "utf8");
  const records = parseRecords(raw);
  if (records === null) {
    writeFileSync(`${file}.bak`, raw);
    writeFileSync(file, EMPTY_ARRAY);
    console.error(`[DEBUG-DUMP] unreadable dump moved to ${file}.bak; started a fresh array`);
    preparedFile = file;
    return;
  }
  // Rewrite only when the layout is not already canonical (JSONL migration, missing
  // trailing bracket, single object, ...). Cheap byte check avoids rewriting every boot.
  const canonical = serializeRecords(records);
  if (raw !== canonical) writeFileSync(file, canonical);
  preparedFile = file;
}

/**
 * Insert one record before the closing bracket, keeping the file a valid JSON array at
 * every moment. Fully synchronous with no await points, so two flushes in the same
 * process cannot interleave and corrupt the file.
 */
function insertRecord(file: string, record: unknown): void {
  const fd = openSync(file, "r+");
  try {
    const size = fstatSync(fd).size;
    const tailLen = Math.min(size, 64);
    const tail = Buffer.alloc(tailLen);
    readSync(fd, tail, 0, tailLen, size - tailLen);
    let idx = tailLen - 1;
    while (idx >= 0 && (tail[idx] === NEWLINE || tail[idx] === SPACE)) idx -= 1;
    if (idx < 0 || tail[idx] !== CLOSE_BRACKET) {
      throw new Error("dump file does not end with ']'");
    }
    const closeOffset = size - tailLen + idx; // absolute position of the trailing ']'
    // prepareArrayFile guarantees the canonical layout `[\n{...}\n]\n`, so once there is at least
    // one record the byte before ']' is a newline. Overwriting that newline keeps the comma at the
    // end of the previous record (`{...},\n{...}`) -- byte-for-byte identical to
    // serializeRecords(), which lets the next boot skip its rewrite check. On an empty array the
    // newline after '[' must stay put, so only shift back when records already exist.
    const hasRecords = closeOffset > ARRAY_OPEN.length;
    const insertAt = hasRecords && idx >= 1 && tail[idx - 1] === NEWLINE ? closeOffset - 1 : closeOffset;
    const line = JSON.stringify(record);
    const chunk = `${insertAt > ARRAY_OPEN.length ? ",\n" : ""}${line}${ARRAY_CLOSE}`;
    // Must be a Buffer: fs.writeSync(fd, string, position, encoding) has a *different* signature
    // from fs.writeSync(fd, buffer, offset, length, position), so passing a string here would
    // silently write at offset 0 and corrupt the array.
    const bytes = Buffer.from(chunk, "utf8");
    writeSync(fd, bytes, 0, bytes.length, insertAt);
    ftruncateSync(fd, insertAt + bytes.length);
  } finally {
    closeSync(fd);
  }
}

function appendRecord(file: string, record: unknown): void {
  prepareArrayFile(file);
  try {
    insertRecord(file, record);
  } catch {
    // A torn write (process killed mid-append) leaves no trailing ']'. Force a re-prepare, which
    // recovers whatever still parses and backs up the rest to <file>.bak, then retry once. Without
    // this the dump would stay permanently unwritable and silently record nothing.
    preparedFile = "";
    prepareArrayFile(file);
    insertRecord(file, record);
  }
}

/**
 * Append one record to the dump file. Never throws -- a debug facility that can take the process
 * down would be worse than the bug it is diagnosing (see the onFlush guard in message-handler).
 */
export function debugDump(record: DumpRecord): void {
  if (!debugDumpEnabled()) return;
  try {
    const file = dumpFile();
    const dir = dirname(file);
    if (dir !== readyDir) {
      mkdirSync(dir, { recursive: true });
      readyDir = dir;
    }
    appendRecord(file, redact(record));
  } catch (error) {
    warnOnce(error);
  }
}

/**
 * Parse the whole dump file into records. Returns [] when the file does not exist.
 * Records are returned exactly as stored -- no re-redaction, so this is also safe for
 * inspecting a file written by an older build.
 */
export function readDebugDump(file: string = dumpFile()): DumpRecord[] {
  if (!existsSync(file)) return [];
  return (parseRecords(readFileSync(file, "utf8")) ?? []) as DumpRecord[];
}

/**
 * Migrate an existing dump file (legacy JSONL, single object, or already-an-array) to the
 * canonical JSON array layout in place, preserving every stored byte of every record.
 *
 * Deliberately does NOT run records through redact(): a stored `signature` is already shortened,
 * and shortening it again silently corrupts it (`…(128)` -> `…(18)`). Anything that rewrites the
 * file must go through prepareArrayFile, which only re-serialises what it parsed.
 */
export function migrateDebugDumpFile(file: string = dumpFile()): { records: number; changed: boolean } {
  const existed = existsSync(file);
  const before = existed ? readFileSync(file, "utf8") : "";
  prepareArrayFile(file);
  const after = readFileSync(file, "utf8");
  return { records: parseRecords(after)?.length ?? 0, changed: before !== after };
}
