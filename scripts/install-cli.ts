import { accessSync, chmodSync, constants, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

export function shellRcPath(home: string, shell: string): string {
  const name = shell.split("/").pop();
  if (name === "zsh") return join(home, ".zshrc");
  if (name === "bash") return join(home, ".bashrc");
  return join(home, ".profile");
}

export function ensurePathLine(rcPath: string, pathLine: string): void {
  let content = "";
  try { content = readFileSync(rcPath, "utf8"); } catch {}
  if (content.split("\n").some((line) => line.trim() === pathLine)) return;
  const prefix = content.length > 0 && !content.endsWith("\n") ? `${content}\n` : content;
  writeFileSync(rcPath, `${prefix}${pathLine}\n`);
}

function isWritableDirectory(path: string): boolean {
  try { return statSync(path).isDirectory() && (accessSync(path, constants.W_OK), true); } catch { return false; }
}

function isCreatableDirectory(path: string): boolean {
  if (existsSync(path)) return isWritableDirectory(path);
  return isWritableDirectory(dirname(path));
}

export function selectBinDir(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const home = env.HOME;
  const prefix = env.PREFIX;
  const entries = (env.PATH ?? "").split(":").map((entry) => entry.trim()).filter((entry) => entry && isAbsolute(entry));
  const preferred = [
    prefix ? join(prefix, "bin") : undefined,
    "/usr/local/bin",
    "/usr/bin",
    home ? join(home, ".local", "bin") : undefined,
    home ? join(home, "bin") : undefined,
  ].filter((entry): entry is string => Boolean(entry));

  for (const entry of preferred) if (entries.includes(entry) && isCreatableDirectory(entry)) return entry;
  for (const entry of entries) if (isCreatableDirectory(entry)) return entry;
  return undefined;
}

export function installCli(root: string, env: NodeJS.ProcessEnv = process.env): void {
  const home = env.HOME ?? root;
  const immediateBinDir = selectBinDir(env);
  const binDir = immediateBinDir ?? join(home, ".local", "bin");
  const target = join(binDir, "aira");
  const bun = process.execPath;

  mkdirSync(binDir, { recursive: true });
  writeFileSync(target, `#!/bin/sh\nexec ${JSON.stringify(bun)} run ${JSON.stringify(join(root, "scripts/aira-cli.ts"))} "$@"\n`);
  chmodSync(target, 0o755);
  console.log(`[AIRA] Installed CLI: ${target}`);

  if (immediateBinDir) return;

  const pathLine = 'export PATH="$HOME/.local/bin:$PATH"';
  const rcPath = shellRcPath(home, env.SHELL ?? "");
  ensurePathLine(rcPath, pathLine);
  console.log(`[AIRA] Added ${binDir} to ${rcPath}.`);
  console.log(`[AIRA] Run: source ${rcPath}`);
}

if (import.meta.main) installCli(process.cwd());
