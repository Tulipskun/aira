/**
 * Prompt templates — the instruction files are prose, the numbers come from the code that owns them.
 *
 * Gemini 1's prompt (`prompts/isla.md`) was always a file; Gemini 2's was a wall of Thai string
 * literals inside `pipeline.ts`, including values that already had owners elsewhere (`+${10}` typed
 * out by hand beside `AFFINITY_NEUTRAL_FLOOR = 10`, the -100..100 range written a second time in the
 * JSON schema, the ladder's rules restated in prose right after `bondLadderWithThresholds()` had
 * listed them). Editing how she reasons about a relationship meant editing TypeScript, and the
 * copies were free to drift.
 *
 * So a prompt file is prose with `{{placeholders}}`, filled from a values object built by the code
 * that owns each number. The split is deliberate:
 *  - **the file** holds wording — what a rule *means*, in the order the model should read it;
 *  - **the values** hold numbers and lists — everything a module can already compute, so changing a
 *    threshold in `sql/bonds.ts` or adding a picture to `images/` reaches the prompt with no prose
 *    edit and no duplicated constant.
 *
 * A placeholder with no value is left **literal** and warned about rather than silently emptied: a
 * prompt that visibly says `{{flirt_requirement}}` in the debug dump is a bug a human can find,
 * while a prompt with the sentence quietly deleted looks like a model that stopped following rules.
 *
 * `<!-- … -->` blocks are stripped before rendering, so a prompt file can document itself for the
 * next editor without that documentation reaching the model.
 */

import { readFileSync, statSync } from "node:fs";

export type PromptValues = Record<string, string | number | undefined>;

/** `{{ key }}` — braces may be padded with spaces, keys are simple identifiers. */
const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g;

/** `<!-- … -->` — maintainer notes that must not reach the model. */
const HTML_COMMENT = /<!--[\s\S]*?-->/g;

/** Drop the file's own documentation. Prompt files are edited by humans, so they carry notes. */
export function stripPromptComments(template: string): string {
  return template.replace(HTML_COMMENT, "").trim();
}

/** Which placeholders a template asks for, in order of first appearance, deduped. */
export function promptPlaceholders(template: string): string[] {
  const seen: string[] = [];
  for (const match of stripPromptComments(template).matchAll(PLACEHOLDER)) {
    if (!seen.includes(match[1])) seen.push(match[1]);
  }
  return seen;
}

/**
 * Substitute `{{key}}` for `values[key]`.
 *
 * Never throws and never deletes text it could not fill — see the module comment for why the
 * literal survives.
 */
export function renderPrompt(template: string, values: PromptValues, label = "prompt"): string {
  const missing: string[] = [];
  const rendered = stripPromptComments(template).replace(PLACEHOLDER, (match, key: string) => {
    const value = values[key];
    if (value === undefined || value === "") {
      if (!missing.includes(key)) missing.push(key);
      return match;
    }
    return String(value);
  });
  if (missing.length) {
    console.warn(`[PROMPT] ${label} has no value for ${missing.map((key) => `{{${key}}}`).join(", ")} -- left as-is`);
  }
  return rendered.trim();
}

/** A prompt file in memory, tagged with the mtime it was read at. */
export type CachedPrompt = { path: string; mtimeMs: number; text: string };

/**
 * Read a prompt file, reusing `previous` while its mtime is unchanged.
 *
 * The text is cached but the *values* are not, which is what lets the file be edited without a
 * restart while the rendered string stays byte-identical for as long as nothing actually changed —
 * the property Gemini 2's prompt cache depends on.
 *
 * When the file becomes unreadable (deleted mid-deploy, `GEMINI2_SYSTEM_PROMPT_FILE` pointed at a
 * path that vanished), the last good text keeps working and the failure is warned about once per
 * distinct reason: losing the instruction file should degrade the prompt, not end the turn. With no
 * previous copy to fall back on there is nothing to render, so that case throws — and it happens at
 * module load in `pipeline.ts`, i.e. at boot, where a missing prompt is a deploy error rather than a
 * mystery later.
 */
export function loadPromptTemplate(absolutePath: string, envName: string, previous?: CachedPrompt): CachedPrompt {
  let mtimeMs = -1;
  try {
    mtimeMs = statSync(absolutePath).mtimeMs;
  } catch {
    mtimeMs = -1;
  }
  if (previous && previous.path === absolutePath && previous.mtimeMs === mtimeMs && mtimeMs !== -1) {
    return previous;
  }
  try {
    return { path: absolutePath, mtimeMs, text: readFileSync(absolutePath, "utf8").trim() };
  } catch (error) {
    const reason = (error as NodeJS.ErrnoException)?.code === "ENOENT" ? "file not found" : String(error);
    if (previous) {
      if (warned.get(absolutePath) !== reason) {
        warned.set(absolutePath, reason);
        console.warn(`[PROMPT] ${absolutePath} unreadable (${reason}) -- still using the last version read from it`);
      }
      return previous;
    }
    throw new Error(`[PROMPT] cannot read ${absolutePath} (${reason}) -- check ${envName}`);
  }
}

const warned = new Map<string, string>();
