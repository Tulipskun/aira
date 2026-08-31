/**
 * Isla's expression images — the catalog is the `images/` directory itself.
 *
 * This used to be a hardcoded list of 28 filenames duplicated in two places (here, and a
 * *different* invented list in the `select_image` enum in `gemini/state-format.ts`). Dropping a
 * picture into `images/` therefore did nothing until somebody remembered to edit the arrays, and
 * the enum Gemini 2 was shown (`happy`, `sad`, `neutral`, …) matched **no file on disk** — so every
 * image the model picked failed to resolve and the embed silently lost its picture.
 *
 * Now one read of the directory + `manifest.json` is the source of truth for:
 *  - what the model may choose (`imageNames()` → the JSON-schema enum),
 *  - what each picture is for (`imageListForPrompt()` → usage notes in Gemini 2's prompt),
 *  - what may be loaded (`fetchEmotionImage()` refuses anything outside the catalog).
 *
 * The filename *is* the token the model answers with. It is self-describing
 * (`isla_angry_fang.jpg`) and it is what the attachment has to be named anyway, so there is no
 * second naming scheme to keep in sync.
 *
 * `manifest.json` maps filename → description, where the description may carry a trailing
 * `//group=<tag>` and the useful half sits after an em dash:
 *   "closeup ตกใจ ตากาง … — ใช้ตอนตกใจ/แปลกใจสุดๆ //group=excited"
 * Unknown keys, missing files and a missing manifest are all tolerated: a picture on disk is
 * offerable even with no description, and a manifest entry with no file on disk is not.
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { config } from "../config.js";

const PROJECT_ROOT = resolve(import.meta.dirname ?? ".", "..", "..");

/** Files the catalog will offer. Anything else in the directory is ignored. */
export const IMAGE_EXTENSIONS: readonly string[] = [".jpg", ".jpeg", ".png", ".webp", ".gif"];
export const MANIFEST_FILE = "manifest.json";

export type ImageEntry = {
  /** Filename on disk — the exact string Gemini 2 must answer with. */
  name: string;
  /** What the picture shows and when to use it ("" when undocumented). */
  usage: string;
  /** `//group=` tag from the manifest, "" when absent. */
  group: string;
};

/** Absolute directory the catalog reads, resolved from the module so cwd cannot change it. */
export function imagesDir(): string {
  return resolve(PROJECT_ROOT, config.paths.images);
}

function isImageFile(name: string): boolean {
  const lower = name.toLowerCase();
  return IMAGE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/** Split a manifest description into its usage text and `//group=` tag. Never throws. */
function parseDescription(raw: unknown): { usage: string; group: string } {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text) return { usage: "", group: "" };
  let group = "";
  const withoutGroup = text
    .replace(/\/\/group\s*=\s*([^\s/]+)/g, (_match, tag: string) => {
      group = tag.trim();
      return "";
    })
    .trim();
  return { usage: withoutGroup, group };
}

function readManifest(dir: string): Record<string, unknown> {
  const path = join(dir, MANIFEST_FILE);
  if (!existsSync(path)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    console.warn(`[IMAGES] ${path} is not a JSON object -- images are offered without descriptions`);
  } catch (error) {
    console.warn(`[IMAGES] could not read ${path}: ${(error as Error).message}`);
  }
  return {};
}

/**
 * Every offerable image, sorted by filename for a stable prompt — and a stable schema enum, since
 * a listing that reordered between turns would invalidate Gemini 2's prompt cache.
 */
export function imageCatalog(dir: string = imagesDir()): ImageEntry[] {
  const key = resolve(dir);
  let files: string[] = [];
  try {
    files = readdirSync(key).filter(isImageFile);
  } catch (error) {
    // A missing images/ directory is a configuration problem, not a reason to lose the reply: the
    // catalog comes back empty and every turn is sent without a picture.
    console.warn(`[IMAGES] could not list ${key}: ${(error as Error).message}`);
  }
  const manifest = readManifest(key);
  const entries = files
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((name) => ({ name, ...parseDescription(manifest[name]) }));
  return entries;
}

/** The filenames only — what the `select_image` enum is built from. */
export function imageNames(dir?: string): string[] {
  return imageCatalog(dir).map((entry) => entry.name);
}

export function isKnownImage(name: string, dir?: string): boolean {
  return imageNames(dir).includes(name);
}

/**
 * The catalog as prompt text: one filename per line with its usage note.
 *
 * Stable across turns (it only changes when the directory does), so it belongs in Gemini 2's
 * *system* prompt where the prompt cache can keep it warm — see `gemini2SystemPrompt`.
 */
export function imageListForPrompt(dir?: string): string {
  const entries = imageCatalog(dir);
  if (!entries.length) return "(ไม่มีรูปภาพให้ใช้ — ส่ง none เสมอ)";
  return entries.map((entry) => `- ${entry.name}${entry.usage ? `: ${entry.usage}` : " (ไม่มีคำอธิบาย)"}`).join("\n");
}

/**
 * Reduce whatever the model wrote to a bare filename.
 *
 * Exported because the parser validates `select_image` before anything is loaded, and a model that
 * answers `images/isla_angry_fang.jpg` means the same picture. It is also the allowlist's first
 * line of defence: taking the last path segment makes `../../etc/passwd` unresolvable.
 */
export function normalizeImageName(fileName: string): string {
  return fileName.trim().split("/").pop() ?? "";
}

/** Absolute path of an allowed image, or undefined when it is not in the catalog. */
export function resolveEmotionImage(fileName: string | undefined, dir: string = imagesDir()): string | undefined {
  if (!fileName) return undefined;
  const normalized = normalizeImageName(fileName);
  return isKnownImage(normalized, dir) ? join(resolve(dir), normalized) : undefined;
}

/**
 * Bytes for the embed attachment, or undefined when the name is unknown or unreadable.
 *
 * The name comes from the model, so it is allowlisted rather than trusted — `normalizeImageName`
 * strips any path a model might try to smuggle in (`../../etc/passwd`).
 */
export async function fetchEmotionImage(fileName: string | undefined, dir?: string): Promise<Buffer | undefined> {
  const path = resolveEmotionImage(fileName, dir);
  if (!path) return undefined;
  try {
    return Buffer.from(readFileSync(path));
  } catch (error) {
    // Listed but unreadable (deleted between listing and send, or a permission problem). The reply
    // must still go out — just without the picture.
    console.warn(`[IMAGES] could not read ${path}: ${(error as Error).message}`);
    return undefined;
  }
}
