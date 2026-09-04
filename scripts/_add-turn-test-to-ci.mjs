import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";

const path = ".github/workflows/ci.yml";
let src = readFileSync(path, "utf8");
const anchor = "      - run: bun run scripts/test-relationship-v2.ts";
const addition = `${anchor}\n      - run: bun run scripts/test-turn-transaction.ts`;
if (!src.includes(anchor)) throw new Error("CI anchor not found");
if (!src.includes("scripts/test-turn-transaction.ts")) src = src.replace(anchor, addition);
writeFileSync(path, src);
execFileSync("git", ["config", "user.name", "github-actions[bot]"]);
execFileSync("git", ["config", "user.email", "41898282+github-actions[bot]@users.noreply.github.com"]);
execFileSync("git", ["add", path]);
execFileSync("git", ["commit", "-m", "test: run atomic turn transaction suite in CI"]);
unlinkSync("scripts/_add-turn-test-to-ci.mjs");
unlinkSync(".github/workflows/_add-turn-test-to-ci.yml");
execFileSync("git", ["add", "scripts/_add-turn-test-to-ci.mjs", ".github/workflows/_add-turn-test-to-ci.yml"]);
execFileSync("git", ["commit", "-m", "chore: remove temporary CI patcher"]);
execFileSync("git", ["push", "origin", "HEAD"]);
