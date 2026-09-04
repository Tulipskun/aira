import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const installer = readFileSync(resolve(import.meta.dir, "../install.sh"), "utf8");

assert.match(installer, /^#!\/usr\/bin\/env bash/m);
assert.match(installer, /git clone --depth 1/);
assert.match(installer, /gh repo clone/);
assert.match(installer, /gh auth status/);
assert.match(installer, /gh auth setup-git/);
assert.match(installer, /bun install/);
assert.match(installer, /bun run install-cli/);
assert.match(installer, /cp \.env\.example \.env/);
assert.match(installer, /AIRA_REPO_URL/);
assert.match(installer, /If this repository is private, install GitHub CLI and run 'gh auth login' first/);
assert.match(installer, /If this repository is private, run 'gh auth login' and 'gh auth setup-git' first/);
assert.match(installer, /CLI is available in the current shell/);
assert.match(installer, /CLI was installed, but the current shell has not reloaded its PATH/);

console.log("installer tests: OK");
