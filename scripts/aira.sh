#!/usr/bin/env bash
# Single entry point for running and deploying Aira on this machine.
#
#   scripts/aira.sh status            show commit, process, health, recent errors
#   scripts/aira.sh start             start detached (no-op when already running)
#   scripts/aira.sh stop              graceful stop, force kill after the drain window
#   scripts/aira.sh restart           stop + start
#   scripts/aira.sh deploy [--force]  pull origin/main, run the tests, restart, verify
#
# Deploy aborts before touching the running bot when the pull or the test suite fails.
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG="${AIRA_LOG:-/root/aira-live.log}"
BRANCH="${AIRA_BRANCH:-main}"
HEALTH_URL="http://127.0.0.1:8091/health"
PATTERN='^\.venv/bin/python -u main\.py$'
OFFSET_FILE="${AIRA_LOG:-/root/aira-live.log}.offset"
DRAIN_SECONDS="${AIRA_DRAIN_SECONDS:-60}"

cd "$APP_DIR"

app_pid() { pgrep -f "$PATTERN" | head -1 || true; }

running() { [ -n "$(app_pid)" ]; }

start() {
  local pid
  pid="$(app_pid)"
  if [ -n "$pid" ]; then
    echo "already running (pid $pid)"
    return 0
  fi
  wc -l < "$LOG" > "$OFFSET_FILE" 2>/dev/null || echo 0 > "$OFFSET_FILE"
  setsid nohup .venv/bin/python -u main.py >> "$LOG" 2>&1 < /dev/null &
  sleep 2
  pid="$(app_pid)"
  if [ -z "$pid" ]; then
    echo "FAILED to start; last log lines:" >&2
    tail -15 "$LOG" >&2
    return 1
  fi
  echo "started (pid $pid) log=$LOG"
}

stop() {
  local pid waited=0
  pid="$(app_pid)"
  if [ -z "$pid" ]; then
    echo "not running"
    return 0
  fi
  kill -TERM "$pid" 2>/dev/null || true
  while kill -0 "$pid" 2>/dev/null; do
    if [ "$waited" -ge "$DRAIN_SECONDS" ]; then
      echo "drain exceeded ${DRAIN_SECONDS}s, forcing kill of $pid"
      kill -9 "$pid" 2>/dev/null || true
      sleep 1
      break
    fi
    sleep 1
    waited=$((waited + 1))
  done
  echo "stopped (waited ${waited}s)"
}

head_commit() { git rev-parse --short HEAD; }

health() {
  curl -sS -m 5 "$HEALTH_URL" 2>/dev/null || true
}

status() {
  echo "dir        $APP_DIR"
  printf 'commit     %s (origin/%s %s)\n' "$(head_commit)" "$BRANCH" "$(git rev-parse --short "origin/$BRANCH" 2>/dev/null || echo '?')"
  echo "tree       $(git status --porcelain | wc -l) changed file(s)"
  if running; then
    echo "process    pid $(app_pid) up $(ps -o etime= -p "$(app_pid)" | tr -d ' ')"
  else
    echo "process    not running"
  fi
  echo "log        $LOG ($(wc -l < "$LOG") lines)"
  local payload
  payload="$(health)"
  if [ -n "$payload" ]; then
    echo "health     $(printf '%s' "$payload" | sed -E 's/.*"ok": ?([a-z]+).*"gatewayReady": ?([a-z]+).*/ok=\1 gateway=\2/')"
  else
    echo "health     no response from $HEALTH_URL"
  fi
  local offset errors
  offset="$(cat "$OFFSET_FILE" 2>/dev/null || echo 0)"
  errors="$(tail -n +$((offset + 1)) "$LOG" 2>/dev/null | grep -c ERROR || true)"
  echo "errors     $errors since this run started"
}

deploy() {
  local force="${1:-}"
  echo "== pull =="
  git fetch --quiet origin "$BRANCH"
  local before after
  before="$(head_commit)"
  if ! git pull --ff-only --quiet origin "$BRANCH"; then
    echo "pull failed; nothing was restarted" >&2
    return 1
  fi
  after="$(head_commit)"
  echo "$before -> $after"

  echo "== tests =="
  if ! .venv/bin/python -m unittest discover -s tests 2>&1 | tail -3; then
    echo "tests failed; the running bot is untouched" >&2
    return 1
  fi

  if [ "$before" = "$after" ] && running && [ "$force" != "--force" ]; then
    echo "== nothing new to deploy; bot left running (use --force to restart) =="
    status
    return 0
  fi

  echo "== restart =="
  stop
  start

  echo "== verify =="
  sleep 10
  if ! running; then
    echo "FAILED: process is not running after deploy" >&2
    tail -20 "$LOG" >&2
    return 1
  fi
  local payload
  payload="$(health)"
  case "$payload" in
    *'"ok": true'*) echo "health ok" ;;
    *) echo "WARNING: health endpoint did not report ok yet" >&2 ;;
  esac
  status
}

case "${1:-status}" in
  start) start ;;
  stop) stop ;;
  restart) stop; start ;;
  deploy) deploy "${2:-}" ;;
  status) status ;;
  *)
    echo "usage: $0 {status|start|stop|restart|deploy [--force]}" >&2
    exit 2
    ;;
esac
