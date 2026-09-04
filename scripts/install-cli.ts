import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function shellRcPath(home: string, shell: string): string {
  const name = shell.split("/").pop();
  if (name === "zsh") return join(home, ".zshrc");
  if (name === "bash") return join(home, ".bashrc");
  return join(home, ".profile");
}

export function ensurePathLine(rcPath: string, pathLine: string): void {
  let content = "";
  try {
    content = readFileSync(rcPath, "utf8");
  } catch {
    // The shell config does not exist yet; it will be created below.
  }

  if (content.split("\n").some((line) => line.trim() === pathLine)) return;

  const prefix = content.length > 0 && !content.endsWith("\n") ? `${content}\n` : content;
  writeFileSync(rcPath, `${prefix}${pathLine}\n`);
}

export function installCli(root: string, env: NodeJS.ProcessEnv = process.env): void {
  const home = env.HOME ?? root;
  const usingPrefix = Boolean(env.PREFIX);
  const binDir = usingPrefix ? join(env.PREFIX!, "bin") : join(home, ".local", "bin");
  const target = join(binDir, "aira");
  const bun = process.execPath;

  mkdirSync(binDir, { recursive: true });
  writeFileSync(target, `#!/bin/sh\nexec ${JSON.stringify(bun)} run ${JSON.stringify(join(root, "scripts/aira-cli.ts"))} "$@"\n`);
  chmodSync(target, 0o755);

  console.log(`[AIRA] Installed CLI: ${target}`);

  if (!usingPrefix) {
    const pathLine = 'export PATH="$HOME/.local/bin:$PATH"';
    const rcPath = shellRcPath(home, env.SHELL ?? "");
    ensurePathLine(rcPath, pathLine);

    const currentPath = env.PATH?.split(":") ?? [];
    if (!currentPath.includes(binDir)) {
      console.log(`[AIRA] Added ${binDir} to ${rcPath}.`);
      console.log(`[AIRA] Run: source ${rcPath}`);
    }
  }
}

if (import.meta.main) installCli(process.cwd());
