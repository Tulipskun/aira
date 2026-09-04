import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensurePathLine, shellRcPath } from "./install-cli.js";

const root = mkdtempSync(join(tmpdir(), "aira-install-cli-"));
const bashrc = join(root, ".bashrc");

writeFileSync(bashrc, "export EDITOR=vi\n");
assert.equal(shellRcPath(root, "bash"), bashrc);
assert.equal(shellRcPath(root, "zsh"), join(root, ".zshrc"));

ensurePathLine(bashrc, 'export PATH="$HOME/.local/bin:$PATH"');
let content = readFileSync(bashrc, "utf8");
assert.match(content, /export PATH=\"\$HOME\/\.local\/bin:\$PATH\"/);

ensurePathLine(bashrc, 'export PATH="$HOME/.local/bin:$PATH"');
content = readFileSync(bashrc, "utf8");
assert.equal((content.match(/export PATH=\"\$HOME\/\.local\/bin:\$PATH\"/g) ?? []).length, 1);

console.log("install-cli tests: OK");
