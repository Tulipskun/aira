# Repository Structure Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reorganize the Aira repository by responsibility without changing runtime behavior, then verify the complete application still typechecks and starts correctly.

**Architecture:** Move application code under `src/` with bounded modules for Discord, Gemini, pipeline, memory, and SQL. Keep `scripts/` for process management, `docs/` for documentation, `images/` for static assets, and `.aira/` for runtime state/data. Update all imports and entry points rather than leaving compatibility copies in the old locations.

**Tech Stack:** Bun, TypeScript, discord.js, `@google/genai`, Chroma, Bun SQLite, dotenv.

**Spec:** `docs/architecture.md` and this plan.

## Global Constraints

- Preserve existing behavior; this is a structural refactor, not a feature rewrite.
- `bun start`, `bun stop`, and `bun logs` must remain the public runtime commands.
- Runtime data belongs under `.aira/`; do not commit secrets, databases, logs, PID files, or Chroma data.
- Gemini 1 remains the dialogue model; Gemini 2 remains the post-response/tool-processing model; Gemini Embedding 2 remains the embedding model.
- Gemini 1 system prompt must remain editable as a file, not hardcoded into TypeScript.
- Do not hardcode API keys or model names in source files when configuration already exists in `.env`/config.
- `!` messages remain command/ignore handling; valid owner-only commands remain functional.
- Response-channel locking and the 5-second debounce / 12-second maximum batching behavior must remain unchanged.
- After each structural task, run `bun run typecheck` and commit independently.

---

## Target Structure

```text
aira/
├── src/
│   ├── bot/
│   │   ├── bot.ts
│   │   ├── commands.ts
│   │   ├── message-handler.ts
│   │   ├── discord-config.ts
│   │   └── images.ts
│   ├── gemini/
│   │   ├── client.ts
│   │   └── prompts/
│   │       └── isla.md
│   ├── pipeline/
│   │   ├── pipeline.ts
│   │   └── scheduler.ts
│   ├── memory/
│   │   ├── chroma.ts
│   │   └── embedding.ts
│   ├── sql/
│   │   ├── history.ts
│   │   ├── profile.ts
│   │   └── relationship.ts
│   └── config.ts
├── scripts/
│   ├── supervisor.ts
│   └── daemon.ts
├── images/
├── docs/
├── .aira/
├── package.json
└── tsconfig.json
```

`src/gemini/client.ts` owns the Google GenAI client, key rotation, request/response conversion, fake tool results, and context-window request construction. `src/gemini/prompts/isla.md` owns the editable Gemini 1 system prompt. `src/config.ts` owns environment-derived model/path configuration.

`src/bot/` owns Discord-specific behavior only. `src/pipeline/` owns batching and orchestration. `src/memory/` owns embedding and Chroma. `src/sql/` owns SQLite persistence.

---

### Task 1: Inventory current modules and lock the move map

**Files:**
- Inspect: `bot.ts`, `gemini.ts`, `pipeline.ts`, `scheduler.ts`, `discord_config.ts`, `images.ts`, `config.ts`
- Inspect: `memory/chroma.ts`, `memory/embedding.ts`
- Inspect: `sql/history.ts`, `sql/profile.ts`, `sql/relationship.ts`
- Inspect: `scripts/supervisor.ts`, `scripts/daemon.ts`, `package.json`, `tsconfig.json`, `docs/architecture.md`

- [ ] **Step 1:** Run `find . -maxdepth 3 -type f | sort` and identify every source/document/runtime file.
- [ ] **Step 2:** Search imports with `grep -R 'from "\./\|from "\.\./' --include='*.ts' .` and record every dependency edge.
- [ ] **Step 3:** Confirm there is exactly one authoritative implementation for each module before moving it; do not create duplicate compatibility copies.
- [ ] **Step 4:** Record the current entry point and package scripts. `package.json` currently exposes `typecheck`, `start`, `stop`, and `logs`; preserve those interfaces.
- [ ] **Step 5:** Commit the inventory only if documentation was changed; otherwise use this task as the preflight gate for Task 2.

---

### Task 2: Create the `src/` module structure

**Files:**
- Create directories: `src/bot/`, `src/gemini/prompts/`, `src/pipeline/`, `src/memory/`, `src/sql/`
- Modify: `src/config.ts`

- [ ] **Step 1:** Create the directories with `mkdir -p src/bot src/gemini/prompts src/pipeline src/memory src/sql`.
- [ ] **Step 2:** Move `config.ts` to `src/config.ts` and update imports after all moves are complete.
- [ ] **Step 3:** Move `gemini.ts` to `src/gemini/client.ts`.
- [ ] **Step 4:** Move `pipeline.ts` to `src/pipeline/pipeline.ts`.
- [ ] **Step 5:** Move `scheduler.ts` to `src/pipeline/scheduler.ts`.
- [ ] **Step 6:** Move `bot.ts` to `src/bot/bot.ts`.
- [ ] **Step 7:** Move `discord_config.ts` to `src/bot/discord-config.ts`.
- [ ] **Step 8:** Move `images.ts` to `src/bot/images.ts`.
- [ ] **Step 9:** Move `memory/chroma.ts` and `memory/embedding.ts` into `src/memory/`.
- [ ] **Step 10:** Move `sql/history.ts`, `sql/profile.ts`, and `sql/relationship.ts` into `src/sql/`.
- [ ] **Step 11:** Move the existing Isla prompt to `src/gemini/prompts/isla.md`; if the prompt currently exists elsewhere, preserve its exact content during the move.
- [ ] **Step 12:** Confirm the old source paths no longer exist.
- [ ] **Step 13:** Commit: `git add src && git rm ... && git commit -m "refactor: organize source modules"`.

---

### Task 3: Repair all TypeScript import boundaries

**Files:**
- Modify: every moved `.ts` file with relative imports
- Modify: `scripts/daemon.ts`
- Modify: `tsconfig.json` only if required by the chosen source root

- [ ] **Step 1:** Update `src/bot/bot.ts` imports to `../pipeline/pipeline.js`, `../pipeline/scheduler.js`, `./images.js`, and `./discord-config.js`.
- [ ] **Step 2:** Update `src/pipeline/pipeline.ts` imports to `../gemini/client.js`, `../memory/embedding.js`, `../memory/chroma.js`, `../sql/history.js`, `../sql/relationship.js`, `../sql/profile.js`, and `../config.js`.
- [ ] **Step 3:** Update `src/gemini/client.ts` to import `../config.js`.
- [ ] **Step 4:** Update moved memory and SQL modules so their relative imports point to their new locations.
- [ ] **Step 5:** Search for stale paths: `grep -R '"\./gemini\|"\./pipeline\|"\./scheduler\|"\./memory/\|"\./sql/\|"\./config\|bot.ts' --include='*.ts' .` and remove every obsolete source-path reference.
- [ ] **Step 6:** Run `bun run typecheck`. Expected: no TypeScript errors.
- [ ] **Step 7:** Commit: `git add src scripts tsconfig.json && git commit -m "refactor: update module imports"`.

---

### Task 4: Make runtime entry points use the new source layout

**Files:**
- Modify: `scripts/daemon.ts`
- Modify: `package.json`

- [ ] **Step 1:** Change the daemon child process from `bun run bot.ts` to `bun run src/bot/bot.ts`.
- [ ] **Step 2:** Keep Chroma path exactly `.aira/chroma` and keep port `127.0.0.1:8000`.
- [ ] **Step 3:** Keep supervisor PID/log paths under `.aira/`.
- [ ] **Step 4:** Preserve package scripts exactly as public commands: `bun start`, `bun stop`, `bun logs`.
- [ ] **Step 5:** Run `bun run typecheck`.
- [ ] **Step 6:** Run `bun start`, verify the command returns to the shell, then inspect `.aira/supervisor.pid` and `bun logs`.
- [ ] **Step 7:** Run `bun stop` and verify the PID disappears and Chroma/Aira stop.
- [ ] **Step 8:** Commit: `git add scripts/daemon.ts package.json && git commit -m "refactor: update runtime entrypoint"`.

---

### Task 5: Centralize Gemini files and editable prompt

**Files:**
- Modify: `src/gemini/client.ts`
- Modify: `src/config.ts`
- Create/Move: `src/gemini/prompts/isla.md`
- Modify: `.env.example` if present

- [ ] **Step 1:** Ensure `config.models.gemini1`, `config.models.gemini2`, and `config.models.embedding2` are the only model configuration values used by runtime code.
- [ ] **Step 2:** Ensure the Gemini 1 prompt path is resolved relative to the repository/runtime root rather than depending on the caller's current working directory. Use an absolute path derived from `import.meta.dir` or the project root.
- [ ] **Step 3:** Keep the Isla prompt external to TypeScript. Load its complete contents at runtime.
- [ ] **Step 4:** Keep `<user_profile>...</user_profile>` appended to Gemini 1's system instruction. The profile must contain only name, relationship label, nicknames, and facts; do not add XP or affinity.
- [ ] **Step 5:** Run `bun run typecheck`.
- [ ] **Step 6:** Verify changing `src/gemini/prompts/isla.md` changes the Gemini 1 system prompt without source-code edits.
- [ ] **Step 7:** Commit: `git add src/gemini src/config.ts .env.example && git commit -m "refactor: isolate Gemini client and prompt"`.

---

### Task 6: Keep memory and SQL boundaries clean

**Files:**
- Modify: `src/memory/chroma.ts`
- Modify: `src/memory/embedding.ts`
- Modify: `src/sql/history.ts`
- Modify: `src/sql/profile.ts`
- Modify: `src/sql/relationship.ts`

- [ ] **Step 1:** Ensure all SQLite databases resolve to `.aira/aira.db` and create their parent directory before opening the database.
- [ ] **Step 2:** Ensure Chroma persists to `.aira/chroma` and no source code uses a repository-root `data/` directory.
- [ ] **Step 3:** Ensure embedding uses the configured Gemini Embedding 2 model rather than a local embedding implementation.
- [ ] **Step 4:** Ensure Chroma memory metadata conforms to the current `Memory` type; do not store unsupported array/object values in metadata unless the type and Chroma schema are explicitly updated together.
- [ ] **Step 5:** Run `bun run typecheck`.
- [ ] **Step 6:** Start the service and verify Chroma heartbeat: `curl http://127.0.0.1:8000/api/v2/heartbeat`.
- [ ] **Step 7:** Verify `.aira/aira.db` and `.aira/chroma/chroma.sqlite3` exist after startup.
- [ ] **Step 8:** Commit: `git add src/memory src/sql && git commit -m "refactor: isolate persistence modules"`.

---

### Task 7: Keep Discord handling isolated

**Files:**
- Modify: `src/bot/bot.ts`
- Modify: `src/bot/commands.ts`
- Modify: `src/bot/message-handler.ts`
- Modify: `src/bot/discord-config.ts`
- Modify: `src/bot/images.ts`

- [ ] **Step 1:** Extract owner-only command parsing/handling into `commands.ts` without changing command names.
- [ ] **Step 2:** Preserve valid commands `!islacomehere` and `!unset`; unknown `!` messages must be ignored.
- [ ] **Step 3:** Preserve persistent response-channel locking across restarts.
- [ ] **Step 4:** Keep Discord-specific message conversion and embed rendering inside `bot/`.
- [ ] **Step 5:** Keep the AI response as a Discord embed containing response text, optional emotion image, and footer `Isla`.
- [ ] **Step 6:** Run `bun run typecheck`.
- [ ] **Step 7:** Run the bot and manually verify: normal message is scheduled, `!unknown` is ignored, owner commands work, and a response is sent as an embed.
- [ ] **Step 8:** Commit: `git add src/bot && git commit -m "refactor: isolate Discord handlers"`.

---

### Task 8: Preserve scheduler and pipeline behavior

**Files:**
- Modify: `src/pipeline/scheduler.ts`
- Modify: `src/pipeline/pipeline.ts`

- [ ] **Step 1:** Preserve per-user batching: a new message from the same user resets the 5-second quiet-period timer.
- [ ] **Step 2:** Preserve the 12-second maximum wait from the first pending message.
- [ ] **Step 3:** Preserve interruption: a message from another user flushes the pending user immediately.
- [ ] **Step 4:** Preserve Gemini order: Gemini 1 generates the dialogue response first; Gemini 2 runs only after Gemini 1 has returned.
- [ ] **Step 5:** Preserve the user profile block before Gemini 1, including name, relationship, nicknames, and facts only.
- [ ] **Step 6:** Preserve Gemini 2's responsibility for relationship/stat updates, memory ingestion, and image selection.
- [ ] **Step 7:** Run `bun run typecheck`.
- [ ] **Step 8:** Manually test the sequence `Yuuta@12:00:00`, `Yuuta@12:00:02`, `Farris@12:00:04` and verify Yuuta flushes at the interruption rather than waiting until 12:00:07.
- [ ] **Step 9:** Commit: `git add src/pipeline && git commit -m "refactor: isolate message pipeline"`.

---

### Task 9: Update documentation to match the final tree

**Files:**
- Modify: `docs/architecture.md`
- Modify: all other repository `.md` files that document source paths

- [ ] **Step 1:** Replace old root paths such as `bot.ts`, `gemini.ts`, and `pipeline.ts` with their new `src/...` paths.
- [ ] **Step 2:** Document the module ownership boundaries and target tree exactly.
- [ ] **Step 3:** Document `.aira/aira.db`, `.aira/chroma`, `.aira/logs`, and `.aira/supervisor.pid` as runtime state.
- [ ] **Step 4:** Document `bun start`, `bun stop`, and `bun logs`.
- [ ] **Step 5:** Document the Gemini 1 → Gemini 2 sequencing and Gemini Embedding 2 → Chroma flow.
- [ ] **Step 6:** Document the `<user_profile>` schema without XP/affinity.
- [ ] **Step 7:** Run a repository-wide search for stale file paths and fix every documentation reference.
- [ ] **Step 8:** Commit: `git add docs && git commit -m "docs: update architecture after refactor"`.

---

### Task 10: Runtime ignore and final verification

**Files:**
- Modify: `.gitignore`
- Verify: all source/config/docs files

- [ ] **Step 1:** Ensure `.gitignore` excludes `.env`, `.aira/`, `node_modules/`, generated logs, SQLite files, Chroma storage, PID/state files, and Python virtual environments.
- [ ] **Step 2:** Ensure source files and editable prompts remain tracked.
- [ ] **Step 3:** Run `git status --short` and confirm no runtime data or secrets are staged.
- [ ] **Step 4:** Run `bun install`.
- [ ] **Step 5:** Run `bun run typecheck`; expected: zero errors.
- [ ] **Step 6:** Run `bun start`; expected: shell prompt returns immediately and supervisor remains running in background.
- [ ] **Step 7:** Run `bun logs`; expected: Chroma starts on `127.0.0.1:8000` and Aira starts from `src/bot/bot.ts`.
- [ ] **Step 8:** Run `bun stop`; expected: supervisor, Aira, and Chroma stop cleanly.
- [ ] **Step 9:** Run `git diff --check`.
- [ ] **Step 10:** Commit: `git add .gitignore && git commit -m "chore: finalize repository structure"`.

---

## Final Acceptance Criteria

- [ ] No application `.ts` files remain at repository root except configuration files explicitly intended to remain there.
- [ ] No duplicate old/new implementations exist.
- [ ] `src/gemini/` contains Gemini client code and editable Isla prompt.
- [ ] `src/bot/` contains Discord-only code.
- [ ] `src/pipeline/` contains scheduler/orchestration.
- [ ] `src/memory/` contains embedding/Chroma integration.
- [ ] `src/sql/` contains SQLite persistence.
- [ ] `scripts/` contains only process-management scripts.
- [ ] Runtime data is under `.aira/` and ignored by Git.
- [ ] `bun run typecheck` passes.
- [ ] `bun start` returns immediately while services remain running.
- [ ] `bun stop` stops the service tree.
- [ ] `bun logs` exposes runtime logs.
- [ ] Existing Discord behavior and Gemini pipeline behavior are preserved.
