#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const source = path.resolve(__dirname, '..');
const runtime = path.join(os.homedir(), '.local', 'share', 'aira');
const token = (process.env.DISCORD || process.env.ISLA_TOKEN || '').trim();

function fail(message) {
  console.error('[AIRA] ' + message);
  process.exit(1);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: runtime,
    stdio: 'inherit',
    env: process.env,
    ...options,
  });
  if (result.error) fail(result.error.message);
  if (result.status !== 0) process.exit(result.status || 1);
}

function copyRuntime() {
  fs.mkdirSync(runtime, { recursive: true, mode: 0o700 });
  fs.cpSync(source, runtime, {
    recursive: true,
    force: true,
    filter(file) {
      const relative = path.relative(source, file).split(path.sep);
      if (relative[0] === '.git' || relative[0] === 'node_modules' || relative[0] === '.aira') return false;
      if (relative[0] === 'bin' && relative.length > 1 && relative[1] === 'aira.js') return false;
      if (relative[0] === '.env' || relative[0] === 'package-lock.json') return false;
      return true;
    },
  });
}

function saveToken() {
  const envFile = path.join(runtime, '.env');
  let lines = [];
  try { lines = fs.readFileSync(envFile, 'utf8').split(/\r?\n/); } catch {}
  const kept = lines.filter(line => !/^\s*(ISLA_TOKEN|DISCORD)\s*=/.test(line));
  kept.push('ISLA_TOKEN=' + JSON.stringify(token));
  fs.writeFileSync(envFile, kept.filter(Boolean).join('\n') + '\n', { mode: 0o600 });
  try { fs.chmodSync(envFile, 0o600); } catch {}
}

function ensureBun() {
  const check = spawnSync('bun', ['--version'], { encoding: 'utf8' });
  if (check.status === 0) return;
  fail('Bun runtime is required. Install Bun first: https://bun.sh');
}

function main() {
  if (process.argv.length > 2) fail('Aira เริ่มต้นด้วยคำสั่งเดียว: npx aira');
  if (!token) fail('ต้องกำหนด Discord token ก่อน: export DISCORD=YOUR_BOT_TOKEN && npx aira');
  copyRuntime();
  saveToken();
  ensureBun();
  console.log('[AIRA] Installing runtime dependencies (first run may take a few minutes)...');
  run('bun', ['install', '--frozen-lockfile']);
  console.log('[AIRA] Starting Discord bot...');
  run('bun', ['run', 'scripts/supervisor.ts', 'start']);
}

main();
