import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const installer = readFileSync(resolve(import.meta.dir, "../install.sh"), "utf8");

assert.match(installer, /^#!\/usr\/bin\/env bash/m);
assert.match(installer, /git clone --depth 1/);
assert.match(installer, /bun install/);
assert.match(installer, /bun run install-cli/);
assert.match(installer, /cp \.env\.example \.env/);
assert.match(installer, /AIRA_REPO_URL/);

console.log("installer tests: OK");
