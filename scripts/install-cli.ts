import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const root = process.cwd();
const home = process.env.HOME ?? root;
const binDir = process.env.PREFIX ? join(process.env.PREFIX, "bin") : join(home, ".local", "bin");
const target = join(binDir, "aira");
const bun = process.execPath;

mkdirSync(binDir, { recursive: true });
writeFileSync(target, `#!/bin/sh\nexec ${JSON.stringify(bun)} run ${JSON.stringify(join(root, "scripts/aira-cli.ts"))} "$@"\n`);
chmodSync(target, 0o755);

console.log(`[AIRA] Installed CLI: ${target}`);
if (!process.env.PREFIX) {
  console.log(`[AIRA] Ensure ${join(home, ".local", "bin")} is in PATH.`);
}
