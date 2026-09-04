#!/usr/bin/env bash
set -euo pipefail

REPO_URL="${AIRA_REPO_URL:-https://github.com/Tulipskun/aira.git}"
INSTALL_ROOT="${AIRA_INSTALL_ROOT:-${HOME}/.local/share/aira}"

say() { printf '[AIRA] %s\n' "$*"; }
fail() { printf '[AIRA] Error: %s\n' "$*" >&2; exit 1; }

command -v curl >/dev/null 2>&1 || fail "curl is required."
command -v git >/dev/null 2>&1 || fail "git is required."

install_package() {
  local package="$1"
  if command -v apt-get >/dev/null 2>&1; then
    if [ "$(id -u)" -eq 0 ]; then apt-get update && apt-get install -y "$package"; else sudo apt-get update && sudo apt-get install -y "$package"; fi
  elif command -v dnf >/dev/null 2>&1; then
    if [ "$(id -u)" -eq 0 ]; then dnf install -y "$package"; else sudo dnf install -y "$package"; fi
  elif command -v yum >/dev/null 2>&1; then
    if [ "$(id -u)" -eq 0 ]; then yum install -y "$package"; else sudo yum install -y "$package"; fi
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

if ! command -v unzip >/dev/null 2>&1 && ! command -v bun >/dev/null 2>&1; then
  say "unzip not found; installing it for Bun..."
  install_package unzip
fi

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

clone_repo() {
  local destination="$1"
  if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
    say "Downloading Aira using GitHub CLI authentication..."
    gh repo clone "${REPO_URL%.git}" "$destination" -- --depth=1
  else
    git clone --depth 1 "$REPO_URL" "$destination"
  fi
}

if [ -d "${INSTALL_ROOT}/.git" ]; then
  say "Updating Aira source..."
  if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
    git -C "$INSTALL_ROOT" pull --ff-only
  else
    git -C "$INSTALL_ROOT" pull --ff-only
  fi
else
  mkdir -p "$(dirname "$INSTALL_ROOT")"
  if [ -e "$INSTALL_ROOT" ]; then
    fail "Install directory exists but is not an Aira git checkout: $INSTALL_ROOT"
  fi
  clone_repo "$INSTALL_ROOT"
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
printf '[AIRA] Run: aira setup\n'
printf '[AIRA] Then run: aira start\n'
