#!/usr/bin/env bash
set -euo pipefail

REPO_URL="${AIRA_REPO_URL:-https://github.com/Tulipskun/aira.git}"
INSTALL_ROOT="${AIRA_INSTALL_ROOT:-${HOME}/.local/share/aira}"

say() { printf '[AIRA] %s\n' "$*"; }
fail() { printf '[AIRA] Error: %s\n' "$*" >&2; exit 1; }

command -v curl >/dev/null 2>&1 || fail "curl is required."
command -v git >/dev/null 2>&1 || fail "git is required."

if ! command -v bun >/dev/null 2>&1; then
  if [ -n "${PREFIX:-}" ] && command -v pkg >/dev/null 2>&1; then
    say "Bun not found; installing Bun with pkg..."
    pkg install -y bun
  else
    say "Bun not found; installing Bun..."
    curl -fsSL https://bun.sh/install | bash
    export BUN_INSTALL="${BUN_INSTALL:-${HOME}/.bun}"
    export PATH="${BUN_INSTALL}/bin:${PATH}"
  fi
fi

command -v bun >/dev/null 2>&1 || fail "Bun installation completed but 'bun' is not on PATH."

if [ -d "${INSTALL_ROOT}/.git" ]; then
  say "Updating Aira source..."
  git -C "$INSTALL_ROOT" pull --ff-only
else
  mkdir -p "$(dirname "$INSTALL_ROOT")"
  if [ -e "$INSTALL_ROOT" ]; then
    fail "Install directory exists but is not an Aira git checkout: $INSTALL_ROOT"
  fi
  say "Downloading Aira..."
  git clone --depth 1 "$REPO_URL" "$INSTALL_ROOT"
fi

cd "$INSTALL_ROOT"

if [ ! -f .env ]; then
  cp .env.example .env
  say "Created $INSTALL_ROOT/.env from .env.example"
else
  say "Keeping existing $INSTALL_ROOT/.env"
fi

say "Installing dependencies..."
bun install

say "Installing the 'aira' command..."
bun run install-cli

printf '\n[AIRA] Installation complete.\n'
printf '[AIRA] Edit: %s/.env\n' "$INSTALL_ROOT"
printf '[AIRA] Then run: aira start\n'
