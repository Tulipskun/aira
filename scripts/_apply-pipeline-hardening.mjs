import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";

const path = "src/pipeline/pipeline.ts";
let src = readFileSync(path, "utf8");

const oldImport = 'import { addFacts, addNicknames, applyTurnState, APPROVAL_NAMES, bondDescription, getUserProfile, upsertUserProfile, type UserProfile } from "../sql/profile.js";';
const newImport = 'import { APPROVAL_NAMES, bondDescription, getUserProfile, upsertUserProfile, type UserProfile } from "../sql/profile.js";\nimport { applyTurnStateAtomic } from "../sql/turn-transaction.js";';
if (!src.includes(oldImport)) throw new Error("profile import anchor not found");
src = src.replace(oldImport, newImport);

const stateRe = /export async function applyState\(state: IslaState, userId: string, timestamp: string, userName: string, _sessionKey\?: string\): Promise<TurnApplyResult> \{.*?\n?\}\nexport async function ingestMemoryBackground/s;
const replacement = `export async function applyState(state: IslaState, userId: string, timestamp: string, userName: string, sessionKey = ""): Promise<TurnApplyResult> {\n  if (!sessionKey) throw new Error("sessionKey is required for atomic turn state application");\n  const xpDelta = state.affinity + (state.isFlirt === true ? FLIRT_XP_BONUS : 0);\n  const result = applyTurnStateAtomic({\n    userId,\n    userName,\n    affinity: xpDelta,\n    isFlirt: state.isFlirt,\n    approvals: { lover: state.approveLover === true, soulmate: state.approveSoulmate === true, sibling: state.approveSibling === true, family: state.approveFamily === true },\n  }, state.addFacts, state.addNicknames, timestamp, sessionKey);\n  if (!result.duplicate) {\n    if (result.derivation.changed) console.log(\\`[PIPELINE] \\${userId}: bond \\${result.before} -> \\${result.after} (\\${result.derivation.reason})\\`);\n    if (result.factsAdded) console.log(\\`[PIPELINE] \\${userId}: +\\${result.factsAdded} fact(s)\\`);\n    if (result.nicknamesAdded) console.log(\\`[PIPELINE] \\${userId}: +\\${result.nicknamesAdded} nickname(s)\\`);\n  } else {\n    console.log(\\`[PIPELINE] \\${userId}: skipped duplicate state application for \\${timestamp}\\`);\n  }\n  const after = result.profile ?? getUserProfile(userId);\n  const effectiveXpDelta = result.duplicate ? 0 : xpDelta;\n  return {\n    ...(state.selectImage ? { image: state.selectImage } : {}),\n    status: { userName: after?.userName ?? userName, bond: after?.bond ?? result.after, xp: after?.xp ?? result.xp, xpDelta: effectiveXpDelta, flirtDelta: result.flirtDelta, bondUnlocked: result.bondUnlocked, nickname: after?.nickname ?? [] },\n  };\n}\nexport async function ingestMemoryBackground`;
if (!stateRe.test(src)) throw new Error("applyState anchor not found");
src = src.replace(stateRe, replacement);

writeFileSync(path, src);
execFileSync("git", ["config", "user.name", "github-actions[bot]"]);
execFileSync("git", ["config", "user.email", "41898282+github-actions[bot]@users.noreply.github.com"]);
execFileSync("git", ["add", path]);
execFileSync("git", ["commit", "-m", "feat: apply turn state atomically"]);

unlinkSync("scripts/_apply-pipeline-hardening.mjs");
unlinkSync(".github/workflows/_apply-pipeline-hardening.yml");
execFileSync("git", ["add", "scripts/_apply-pipeline-hardening.mjs", ".github/workflows/_apply-pipeline-hardening.yml"]);
execFileSync("git", ["commit", "-m", "chore: remove temporary hardening patcher"]);
execFileSync("git", ["push", "origin", "HEAD"]);
