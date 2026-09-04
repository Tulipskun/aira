import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "../config.js";

// Gemini 1 requests carry synthetic `search_memory` tool steps. The Interactions API requires the
// synthetic function_call to be paired with a valid thought signature. Real signatures harvested
// from Gemini 2 are therefore kept in a small process-local cache and reused round-robin.
const STATE_FILE = config.paths.geminiThoughtSignatures;
const MAX_POOL_SIZE = 5;
const DEFAULT_FLUSH_MS = 10 * 60_000;

// Bootstrap only. It is never persisted into the pool and is used only when no real signature has
// been harvested yet, preserving the existing request contract during cold start.
const BOOTSTRAP_SIGNATURE = "El4KXAERTTIPV5DSwWOxBfzxqrZ7KbEV9e9KtO4jGvcB6fuuTxysDRrjCc+qdvx4lAPLBxk1qBtDEvIfZpovKWuoS8XqngT1bXfW4W0Bar04RyQJbG7rvweMa71A1cCR";

function envSignatures(): string[] {
  return (process.env.GEMINI1_THOUGHT_SIGNATURE ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function loadPool(): string[] {
  if (!existsSync(STATE_FILE)) return [];
  try {
    const state = JSON.parse(readFileSync(STATE_FILE, "utf8"));
    if (!Array.isArray(state.signatures)) return [];
    return state.signatures
      .filter((value: unknown): value is string => typeof value === "string" && value.length > 0)
      .slice(-MAX_POOL_SIZE);
  } catch {
    return [];
  }
}

function savePool(signatures: string[]): void {
  mkdirSync(dirname(STATE_FILE), { recursive: true });
  writeFileSync(STATE_FILE, `${JSON.stringify({ signatures: signatures.slice(-MAX_POOL_SIZE) }, null, 2)}\n`);
}

const pool: string[] = [...envSignatures(), ...loadPool()].filter((signature, index, all) => all.indexOf(signature) === index).slice(-MAX_POOL_SIZE);
let cursor = 0;
let dirty = false;
let flushTimer: ReturnType<typeof setTimeout> | undefined;

function flushDelayMs(): number {
  const minutes = Number(process.env.GEMINI_SIGNATURE_FLUSH_MINUTES ?? "10");
  return Number.isFinite(minutes) && minutes > 0 ? minutes * 60_000 : DEFAULT_FLUSH_MS;
}

function scheduleFlush(): void {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = setTimeout(() => {
    flushTimer = undefined;
    if (dirty) flushThoughtSignatures();
  }, flushDelayMs());
  flushTimer.unref?.();
}

function touch(): void {
  scheduleFlush();
}

/** Persist the current in-memory pool. Persistence is best-effort and never breaks a request. */
export function flushThoughtSignatures(): void {
  if (!dirty) return;
  try {
    savePool(pool);
    dirty = false;
  } catch {
    // Keep dirty=true so the next idle/shutdown flush retries the write.
  }
}

function markDirty(): void {
  dirty = true;
  scheduleFlush();
}

function active(): string[] {
  return pool.length ? pool : [BOOTSTRAP_SIGNATURE];
}

export function nextThoughtSignature(): string {
  const signatures = active();
  const signature = signatures[cursor % signatures.length]!;
  cursor = (cursor + 1) % signatures.length;
  touch();
  return signature;
}

export function addThoughtSignature(signature: string | undefined | null): void {
  if (!signature || pool.includes(signature)) {
    touch();
    return;
  }
  pool.push(signature);
  while (pool.length > MAX_POOL_SIZE) pool.shift();
  cursor %= pool.length;
  markDirty();
}

export function invalidateThoughtSignature(signature: string | undefined | null): void {
  if (!signature) {
    touch();
    return;
  }
  const index = pool.indexOf(signature);
  if (index === -1) {
    touch();
    return;
  }
  pool.splice(index, 1);
  cursor = pool.length ? cursor % pool.length : 0;
  markDirty();
}

export function thoughtSignaturePoolSize(): number {
  const size = pool.length || 1;
  touch();
  return size;
}

// The supervisor terminates the bot with SIGTERM. Flush here rather than relying on process exit,
// because Node/Bun may not run asynchronous cleanup once the signal handler exits.
function handleShutdown(): void {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = undefined;
  flushThoughtSignatures();
}

process.once("SIGTERM", handleShutdown);
process.once("SIGINT", handleShutdown);
process.once("beforeExit", handleShutdown);
