#!/usr/bin/env bash
set -euo pipefail

REPO_URL="${AIRA_REPO_URL:-https://github.com/Tulipskun/aira.git}"
INSTALL_ROOT="${AIRA_INSTALL_ROOT:-${HOME}/.local/share/aira}"
TOKEN="${DISCORD:-${ISLA_TOKEN:-}}"

say() { printf '[AIRA] %s\n' "$*"; }
fail() { printf '[AIRA] Error: %s\n' "$*" >&2; exit 1; }

[ -n "$TOKEN" ] || fail "Set your Discord bot token first: export DISCORD=YOUR_DISCORD_BOT_TOKEN"
command -v curl >/dev/null 2>&1 || fail "curl is required."
command -v git >/dev/null 2>&1 || fail "git is required."

install_package() {
  local package="$1"
  if [ -n "${PREFIX:-}" ] && command -v pkg >/dev/null 2>&1; then
    pkg install -y "$package"
  elif command -v apt-get >/dev/null 2>&1; then
    if [ "$(id -u)" -eq 0 ]; then apt-get update && apt-get install -y "$package"; else sudo apt-get update && sudo apt-get install -y "$package"; fi
  elif command -v dnf >/dev/null 2>&1; then
    if [ "$(id -u)" -eq 0 ]; then dnf install -y "$package"; else sudo dnf install -y "$package"; fi
  elif command -v pacman >/dev/null 2>&1; then
    if [ "$(id -u)" -eq 0 ]; then pacman -Sy --noconfirm "$package"; else sudo pacman -Sy --noconfirm "$package"; fi
  elif command -v apk >/dev/null 2>&1; then
    if [ "$(id -u)" -eq 0 ]; then apk add "$package"; else sudo apk add "$package"; fi
  elif command -v brew >/dev/null 2>&1; then
    brew install "$package"
  else
    fail "Cannot install required package '$package': no supported package manager found."
  fi
}

if ! command -v bun >/dev/null 2>&1; then
  if ! command -v unzip >/dev/null 2>&1 && [ "$(uname -s)" = Linux ] && ! { [ -n "${PREFIX:-}" ] && command -v pkg >/dev/null 2>&1; }; then
    say "Installing unzip (required by Bun on Linux)..."
    install_package unzip
  fi
  if [ -n "${PREFIX:-}" ] && command -v pkg >/dev/null 2>&1; then
    say "Installing Bun..."
    pkg install -y bun
  else
    say "Installing Bun..."
    curl -fsSL https://bun.sh/install | bash
    export BUN_INSTALL="${BUN_INSTALL:-${HOME}/.bun}"
    export PATH="${BUN_INSTALL}/bin:${PATH}"
  fi
fi
command -v bun >/dev/null 2>&1 || fail "Bun installation failed or Bun is not on PATH."

if [ -d "${INSTALL_ROOT}/.git" ]; then
  say "Updating Aira..."
  git -C "$INSTALL_ROOT" pull --ff-only
elif [ -e "$INSTALL_ROOT" ]; then
  fail "Install directory exists but is not an Aira Git checkout: $INSTALL_ROOT"
else
  say "Downloading Aira..."
  mkdir -p "$(dirname "$INSTALL_ROOT")"
  git clone --depth 1 "$REPO_URL" "$INSTALL_ROOT"
fi

cd "$INSTALL_ROOT"
[ -f package.json ] || fail "Downloaded repository is missing package.json."
[ -f bun.lock ] || fail "Downloaded repository is missing bun.lock."

# Keep existing local configuration, but always apply the token passed to this invocation.
mkdir -p .aira
chmod 700 .aira
export AIRA_TOKEN_TO_SAVE="$TOKEN"
bun -e '
  import { readFileSync, writeFileSync, chmodSync } from "node:fs";
  const file = ".env";
  let lines = [];
  try { lines = readFileSync(file, "utf8").split(/\r?\n/); } catch {}
  lines = lines.filter(line => !/^\s*(ISLA_TOKEN|DISCORD)\s*=/.test(line));
  lines.push(`ISLA_TOKEN=${JSON.stringify(process.env.AIRA_TOKEN_TO_SAVE ?? "")}`);
  writeFileSync(file, lines.filter(Boolean).join("\n") + "\n", { mode: 0o600 });
  chmodSync(file, 0o600);
' || fail "Unable to save the Discord token securely."
unset AIRA_TOKEN_TO_SAVE

say "Installing dependencies..."
bun install --frozen-lockfile

say "Registering Discord slash commands..."
bun run scripts/register-commands.ts

say "Starting Aira Discord bot..."
bun run scripts/supervisor.ts start
say "Aira is running. Use 'aira logs' to inspect logs if the CLI is installed."
