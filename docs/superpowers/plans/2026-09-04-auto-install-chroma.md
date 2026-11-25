# Automatic Python and Chroma Bootstrap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `aira start` automatically provision Python/Chroma when the local Chroma environment is missing and set the requested Gemini model defaults.

**Architecture:** Add a focused bootstrap module under `scripts/` with an injectable command runner for tests. The supervisor calls it before starting Chroma; the module detects Python and an OS package manager, installs missing Python prerequisites, creates `.aira/chroma-venv`, and installs `chromadb` there. Existing Chroma data and HTTP health-check behavior remain unchanged.

**Tech Stack:** Bun, TypeScript, Node child_process/fs APIs, Python venv, pip, Chroma CLI, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-09-04-auto-install-chroma-design.md`

## Global Constraints

- Gemini 1 default is `gemini-3.1-flash-lite`.
- Gemini 2 default is `gemini-3.5-flash-lite`.
- Chroma is installed only inside `.aira/chroma-venv`.
- Missing Python is installed through a detected system package manager.
- Supported package managers are `apt-get`, `dnf`, `pacman`, and `brew`.
- Chroma data remains `.aira/chroma/` and the server remains on `127.0.0.1:8000`.
- Bootstrap failure must stop startup with an actionable error.
- Existing installations must be reused without reinstalling on every start.

---

### Task 1: Add testable Chroma bootstrap module

**Files:**
- Create: `scripts/chroma-setup.ts`
- Create: `scripts/chroma-setup.test.ts`

**Interfaces:**
- Produces `ensureChroma(root: string): Promise<string>` returning the executable path.
- Internal command execution is injectable so tests never modify the host.

- [ ] **Step 1: Write failing tests** for Python detection, package-manager selection, venv creation, Chroma installation, idempotent reuse, and actionable failure.
- [ ] **Step 2: Run `bun run scripts/chroma-setup.test.ts` and verify the new behavior fails before implementation.
- [ ] **Step 3: Implement detection and installation with `spawnSync`/`spawn`, using package-manager-specific Python installation commands and a private venv.
- [ ] **Step 4: Run the focused test and verify it passes.
- [ ] **Step 5: Run `bun run typecheck`.

### Task 2: Integrate bootstrap into the supervisor

**Files:**
- Modify: `scripts/daemon.ts`

**Interfaces:**
- Consumes `ensureChroma(root)` from Task 1.
- Produces a verified Chroma executable before the existing `spawn()` call.

- [ ] **Step 1: Add the bootstrap call before Chroma is spawned.
- [ ] **Step 2: Preserve `.aira/chroma/`, port `8000`, and the existing heartbeat timeout.
- [ ] **Step 3: Convert bootstrap errors into logged fatal startup errors without starting Aira.
- [ ] **Step 4: Run typecheck and the supervisor/CLI tests.

### Task 3: Set Gemini defaults and document setup behavior

**Files:**
- Modify: `src/config.ts`
- Modify: `.env.example`
- Modify: `README.md`

- [ ] **Step 1: Change only the fallback model values in `src/config.ts`.
- [ ] **Step 2: Document the defaults in `.env.example` without forcing them into a user's existing `.env`.
- [ ] **Step 3: Update setup documentation to explain that `aira start` installs Python/Chroma automatically when required.
- [ ] **Step 4: Run `bun run typecheck` and `bun run test:cli`.

### Task 4: Verify the branch

- [ ] **Step 1: Review the final diff for scope and accidental changes.
- [ ] **Step 2: Run all available repository tests and typecheck.
- [ ] **Step 3: Commit implementation changes.
- [ ] **Step 4: Wait for CI and inspect the workflow result for the commit.
- [ ] **Step 5: If CI fails, fix the failure and repeat verification.
- [ ] **Step 6: Open the pull request against `main` only after verification passes.
