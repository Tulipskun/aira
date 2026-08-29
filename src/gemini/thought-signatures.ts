import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "../config.js";

// Gemini 1 requests carry synthetic `search_memory` tool steps (see fakeToolCallResult).
// The Interactions API only accepts a `function_call` step when the model turn that produced
// it is present as a `thought` step with a valid `signature`. Signatures are not bound to a
// payload and are interchangeable across models, so every Gemini 2 response (which always
// thinks before calling EXECUTE_TOOL) donates its signature to the pool for Gemini 1 to reuse.
const STATE_FILE = config.paths.geminiThoughtSignatures;
const MAX_POOL_SIZE = 32;

// Seed kept as the starting value until real signatures arrive from Gemini 2.
const SEED_SIGNATURE = "El4KXAERTTIPV5DSwWOxBfzxqrZ7KbEV9e9KtO4jGvcB6fuuTxysDRrjCc+qdvx4lAPLBxk1qBtDEvIfZpovKWuoS8XqngT1bXfW4W0Bar04RyQJbG7rvweMa71A1cCR";

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
    return state.signatures.filter((value: unknown): value is string => typeof value === "string" && value.length > 0);
  } catch {
    return [];
  }
}

function savePool(signatures: string[]): void {
  mkdirSync(dirname(STATE_FILE), { recursive: true });
  writeFileSync(STATE_FILE, `${JSON.stringify({ signatures }, null, 2)}\n`);
}

const pool: string[] = loadPool();
const seed: string[] = [...envSignatures(), SEED_SIGNATURE];
let cursor = 0;

function active(): string[] {
  return pool.length ? pool : seed;
}

// Round-robin so a single stale signature is not hammered, and a corrupted one only costs one
// request before `invalidateSignature` drops it from the pool. The seed stays as a fallback
// only while no real signature has been harvested yet.
export function nextThoughtSignature(): string {
  const signatures = active();
  const signature = signatures[cursor % signatures.length];
  cursor = (cursor + 1) % signatures.length;
  return signature;
}

export function addThoughtSignature(signature: string | undefined | null): void {
  if (!signature) return;
  if (pool.includes(signature)) return;
  pool.push(signature);
  while (pool.length > MAX_POOL_SIZE) pool.shift();
  cursor %= pool.length;
  try {
    savePool(pool);
  } catch {
    /* persistence is best-effort; the in-memory pool still works */
  }
}

export function invalidateThoughtSignature(signature: string | undefined | null): void {
  if (!signature) return;
  const index = pool.indexOf(signature);
  if (index === -1) return;
  pool.splice(index, 1);
  cursor = pool.length ? cursor % pool.length : 0;
  try {
    savePool(pool);
  } catch {
    /* persistence is best-effort; the in-memory pool still works */
  }
}

export function thoughtSignaturePoolSize(): number {
  return active().length;
}
