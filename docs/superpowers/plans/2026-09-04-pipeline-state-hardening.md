# Pipeline & State Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden Aira's state and pipeline boundaries, make memory ingestion non-blocking, simplify thought-signature persistence, update relationship progression, clarify timestamps, and synchronize documentation without changing intentional scheduler interruption or 5xx key behavior.

**Architecture:** Keep the synchronous response path focused on Discord input, retrieval, Gemini generation, and structured SQLite state. Apply SQLite state atomically, then return the response; run Chroma memory ingestion as a best-effort background side effect. Keep thought signatures in a bounded in-memory cache and persist them only on idle/shutdown.

**Tech Stack:** Bun, TypeScript, SQLite/better-sqlite3, Chroma, Gemini SDK, Discord.js.

**Spec:** `docs/superpowers/specs/2026-09-04-pipeline-state-hardening-design.md`

## Global Constraints

- Keep cross-session scheduler interruption unchanged.
- Do not rotate API keys for 5xx responses.
- XP is unbounded for leaderboard ranking.
- Gemini 1 remains the user-facing response stage; Gemini 2 remains analyzer/state stage.
- Do not reintroduce the retired execute-tool protocol.
- Main Discord response must not wait for Chroma memory ingestion.
- Changes must be committed through GitHub and verified by GitHub Actions after each commit.
- Do not claim tests pass until the corresponding GitHub Actions run is successful.

---

### Task 1: Atomic structured state mutation

**Files:**
- Modify: `src/state/state_transaction.mjs` or the current state transaction implementation found during inspection
- Modify: `src/relationship/relationship_state.mjs`
- Modify: affected SQLite profile/history modules only where required by the existing transaction interface

**Interfaces:**
- Consumes: current relationship/state inputs and SQLite handles already used by the pipeline.
- Produces: one local atomic state mutation operation that contains relationship/counter/profile changes but no network calls.

- [ ] Step 1: Inspect the current state transaction and identify every SQLite write performed by `applyState()`.
- [ ] Step 2: Convert related same-turn writes to one SQLite transaction using the existing database connection/transaction pattern.
- [ ] Step 3: Ensure no embedding, Chroma, or other network call occurs inside the SQLite transaction.
- [ ] Step 4: Preserve unbounded XP and validate only structural invariants: finite integer XP, non-negative counters, and valid relationship enum.
- [ ] Step 5: Run `bun run typecheck` and the focused existing state/profile tests in CI-capable form.
- [ ] Step 6: Commit `fix: make turn state mutation atomic`.

### Task 2: Separate memory ingestion from state application

**Files:**
- Modify: `src/pipeline/pipeline.ts`
- Modify: current memory ingestion module(s)
- Modify: current state application module if required

**Interfaces:**
- Consumes: Gemini 1 response, Gemini 2 state result, user/session metadata.
- Produces: immediate structured state application plus a separate best-effort memory ingestion task.

- [ ] Step 1: Identify the exact memory work currently awaited by the response path.
- [ ] Step 2: Move embedding/duplicate-check/Chroma writes into a separate `ingestMemory` boundary that accepts explicit event metadata.
- [ ] Step 3: Make state application complete without calling external services.
- [ ] Step 4: Schedule memory ingestion after the response is ready, with errors caught and logged rather than propagated to the turn result.
- [ ] Step 5: Preserve the existing memory payload and retrieval semantics.
- [ ] Step 6: Run typecheck and focused pipeline tests.
- [ ] Step 7: Commit `fix: decouple memory ingestion from response path`.

### Task 3: Thought-signature bounded cache and deferred persistence

**Files:**
- Modify: `src/gemini/thought-signatures.ts`
- Modify: `src/config.mjs` only if a timeout setting is needed
- Modify: `scripts/daemon.ts` or the process shutdown owner if needed

**Interfaces:**
- Consumes: harvested Gemini thought signatures and persisted signature state.
- Produces: `nextThoughtSignature()`, `addThoughtSignature()`, `invalidateThoughtSignature()`, `thoughtSignaturePoolSize()`, and explicit `flushThoughtSignatures()` with a maximum of 5 signatures.

- [ ] Step 1: Replace the 32-entry pool with a maximum of 5 real signatures and preserve deduplication.
- [ ] Step 2: Remove save-on-add and save-on-invalidate behavior.
- [ ] Step 3: Track dirty state and last-use/last-mutation time in memory.
- [ ] Step 4: Add an inactivity timer with a default 10-minute flush interval; reset the timer when signature state is used or changed.
- [ ] Step 5: Add `flushThoughtSignatures()` as an idempotent best-effort persistence operation.
- [ ] Step 6: Register graceful shutdown handling so the pool is flushed before process exit.
- [ ] Step 7: Ensure a failed disk write does not break runtime signature use.
- [ ] Step 8: Remove reliance on the static seed as a substitute for a real harvested signature when real signatures have been invalidated; retain only whatever bootstrap behavior is required by the current Gemini request contract.
- [ ] Step 9: Run typecheck and focused signature tests.
- [ ] Step 10: Commit `fix: bound thought signature cache and defer persistence`.

### Task 4: Relationship progression and flirt XP

**Files:**
- Modify: current relationship ladder/state file(s), including `src/relationship/relationship_state.mjs` or equivalent
- Modify: Gemini state parser/schema if the flirt field needs an explicit numeric bonus
- Modify: relevant prompt/schema documentation

**Interfaces:**
- Consumes: current relationship state plus Gemini 2 relationship analysis.
- Produces: deterministic crush progression and explicit flirt XP bonus.

- [ ] Step 1: Define the new crush rule as `xp >= 500` plus the existing romantic/flirt eligibility condition.
- [ ] Step 2: Define a numeric flirt XP bonus so each accepted flirt contributes more than the counter alone; use the existing state schema if a per-turn affinity value already exists rather than inventing a second competing field.
- [ ] Step 3: Apply the bonus exactly once per accepted flirt event.
- [ ] Step 4: Preserve unbounded total XP for leaderboard ranking.
- [ ] Step 5: Verify transition ordering so higher-priority explicit bonds still win over XP ladder evaluation.
- [ ] Step 6: Run relationship tests and typecheck.
- [ ] Step 7: Commit `feat: revise crush progression and flirt xp`.

### Task 5: Explicit timestamp semantics

**Files:**
- Modify: current memory/fact/episode persistence types and writers
- Modify: `src/pipeline/pipeline.ts`
- Modify: relevant memory retrieval formatting where timestamps are exposed

**Interfaces:**
- Consumes: Discord message/event timestamp.
- Produces: explicit `eventTimestamp` and `createdAt` fields with stable semantics.

- [ ] Step 1: Define `eventTimestamp` as the timestamp of the source user/event and `createdAt` as the timestamp when the stored record is created.
- [ ] Step 2: Pass both values through memory/fact/episode creation.
- [ ] Step 3: Keep existing retrieval ordering based on event time where that is the intended conversational ordering.
- [ ] Step 4: Preserve backward compatibility for existing stored rows/documents by treating missing `createdAt` as unknown rather than rewriting historical data automatically.
- [ ] Step 5: Run typecheck and affected memory tests.
- [ ] Step 6: Commit `fix: clarify memory event and creation timestamps`.

### Task 6: Pipeline responsibility refactor

**Files:**
- Modify: `src/pipeline/pipeline.ts`
- Create: focused pipeline helper modules only where a clear existing boundary is identified

**Interfaces:**
- Consumes: existing processMessage inputs and service dependencies.
- Produces: explicit stage functions for preparation, context retrieval, Gemini 1, persistence, Gemini 2, state application, and result construction.

- [ ] Step 1: Extract only boundaries that already have coherent inputs/outputs; do not rewrite business logic unnecessarily.
- [ ] Step 2: Keep the synchronous ordering required for Gemini 2 state selection and Discord response.
- [ ] Step 3: Keep memory ingestion outside the critical response path as established in Task 2.
- [ ] Step 4: Preserve scheduler behavior and existing per-session interruption.
- [ ] Step 5: Remove duplicated error/logging branches created by the old monolithic flow.
- [ ] Step 6: Run typecheck and the existing pipeline/e2e scripts available in the repository.
- [ ] Step 7: Commit `refactor: clarify pipeline stage boundaries`.

### Task 7: Documentation and cleanup

**Files:**
- Modify: `README.md`
- Modify: `docs/architecture.md`
- Modify: `docs/pipeline.md`
- Modify: `docs/memory.md`
- Modify: `docs/gemini.md`
- Modify: `docs/sql.md`
- Modify: `docs/scheduler.md` only if its terminology is stale
- Modify: `scripts/aira-cli.ts` for confirmed unused constants/import-level state
- Search all repository files for retired execute-tool terminology and update only stale documentation/code comments

**Interfaces:**
- Consumes: final implementation behavior from Tasks 1–6.
- Produces: documentation that describes the actual runtime architecture.

- [ ] Step 1: Update README pipeline flow to distinguish Gemini 1 user response, Gemini 2 analyzer/state, and background memory ingestion.
- [ ] Step 2: Remove stale claims that Gemini 2 uses an execute tool.
- [ ] Step 3: Document the bounded in-memory thought-signature cache and deferred persistence.
- [ ] Step 4: Document the eventTimestamp/createdAt distinction.
- [ ] Step 5: Remove confirmed unused CLI variables without changing CLI behavior.
- [ ] Step 6: Search for stale execute-tool vocabulary and remove only retired references.
- [ ] Step 7: Run the complete repository test/typecheck command set available in package scripts.
- [ ] Step 8: Commit `docs: synchronize architecture and clean stale code`.

### Task 8: Final verification

**Files:**
- No source changes unless verification exposes a defect.

- [ ] Step 1: Inspect the latest GitHub Actions run for the final commit.
- [ ] Step 2: If running, wait approximately 15 seconds and inspect again.
- [ ] Step 3: If failed, inspect logs, fix the actual failure, commit the fix, wait approximately 15 seconds, and repeat this verification loop.
- [ ] Step 4: Confirm `typecheck` and the complete intended test suite pass in GitHub Actions.
- [ ] Step 5: Run final repository checks and inspect the final diff/state.
- [ ] Step 6: If work was performed on a feature branch with a PR, merge the PR after all checks pass. If changes are already on `main`, do not create a meaningless PR solely to satisfy this step.
