# Episodic Memory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add temporal episodic memory to Aira using a dedicated Chroma collection while preserving Gemini 1 turn summaries, SQLite history/facts, and existing semantic memory.

**Architecture:** Build deterministic episodes from recent `messages.summary` records, keyed by session/date/period and split by a configurable inactivity gap. Store them in `aira_episodes` with temporal metadata, recall them semantically and with explicit temporal filters, and inject them into the existing synthetic memory result for Gemini 1.

**Tech Stack:** TypeScript, SQLite via existing history module, ChromaDB, existing embedding service, Bun/TypeScript.

**Spec:** `docs/superpowers/specs/2026-09-04-episodic-memory-design.md`

## Global Constraints

- Keep `messages.summary` unchanged as Gemini 1 turn-level metadata.
- Never copy episodic memories into `user_profiles.facts_json`.
- Keep existing `aira_memories` recall behavior and thresholds unchanged.
- Scope episodes by `sessionKey`.
- Use `ISLA_TIMEZONE` for local date/period classification; timestamps remain UTC.
- Use deterministic episode ids so repeated builds upsert instead of duplicate.

---

### Task 1: Add episode configuration and pure episode helpers

**Files:**
- Modify: `src/config.ts`
- Create: `src/memory/episodic.ts`
- Test: `scripts/test-episodic.ts`

**Interfaces:**
- Produces `episodePeriod(timestamp: string): "morning" | "afternoon" | "evening" | "night"`.
- Produces `episodeId(sessionKey: string, startTime: string, endTime: string): string`.
- Produces `temporalQuery(text: string, now?: Date): { date?: string; period?: EpisodePeriod }`.
- Produces `buildEpisode(summaries: Array<{timestamp:string; summary:string}>, sessionKey: string): Episode | null`.

- [ ] **Step 1: Write failing tests** for Bangkok morning/afternoon/evening/night, deterministic ids, empty-summary rejection, and 30-minute boundaries.
- [ ] **Step 2: Run `bun scripts/test-episodic.ts` and verify the new helper tests fail.**
- [ ] **Step 3: Add the four episode configuration values to `src/config.ts` and implement the pure helpers.**
- [ ] **Step 4: Run `bun scripts/test-episodic.ts` and verify PASS.**
- [ ] **Step 5: Commit** with `feat: add episodic memory helpers`.

### Task 2: Add dedicated Chroma episode storage and retrieval

**Files:**
- Modify: `src/memory/episodic.ts`
- Modify: `src/memory/chroma.ts` only if a shared Chroma utility is required by the implementation
- Test: `scripts/test-episodic.ts`

**Interfaces:**
- `saveEpisode(episode: Episode): Promise<void>`
- `recallEpisodes(vector: number[], sessionKey: string, queryText: string, limit?: number, minSimilarity?: number): Promise<Episode[]>`

- [ ] **Step 1: Add tests for session scoping and temporal metadata filtering using the same Chroma mocking pattern already used by repository memory tests.**
- [ ] **Step 2: Run the episode tests and verify the new storage tests fail.**
- [ ] **Step 3: Implement a dedicated `aira_episodes` Chroma collection with documents, embeddings, and metadata (`type`, `sessionKey`, `date`, `period`, `startTime`, `endTime`).**
- [ ] **Step 4: Implement semantic recall with the configured similarity floor and optional date/period filters from `temporalQuery()`.**
- [ ] **Step 5: Run `bun scripts/test-episodic.ts` and verify PASS.**
- [ ] **Step 6: Commit** with `feat: store and recall episodic memories`.

### Task 3: Build episodes from Gemini 1 summaries in the pipeline

**Files:**
- Modify: `src/sql/history.ts` if a minimal session-scoped summary query is needed
- Modify: `src/memory/episodic.ts`
- Modify: `src/pipeline/pipeline.ts`
- Test: `scripts/test-episodic.ts`

**Interfaces:**
- `buildRecentEpisode(sessionKey: string, currentTimestamp: string): Promise<Episode | null>` reads recent model summaries and creates the current episode.

- [ ] **Step 1: Add a test proving model summaries from one active episode are combined in chronological order and a >gap boundary starts a new episode.**
- [ ] **Step 2: Run the test and verify FAIL.**
- [ ] **Step 3: Implement the recent-summary query and episode builder using existing `getHistory()` data without changing Gemini 1 output.**
- [ ] **Step 4: Call the builder after the Gemini 1 response is stored, save the resulting episode to `aira_episodes`, and keep the existing Gemini 2/analyzer flow unchanged.**
- [ ] **Step 5: Run the episode tests and typecheck.**
- [ ] **Step 6: Commit** with `feat: build episodic memories from turn summaries`.

### Task 4: Feed episodic memories into Gemini 1 recall

**Files:**
- Modify: `src/pipeline/pipeline.ts`
- Modify: `src/memory/episodic.ts`
- Test: `scripts/test-episodic.ts`

**Interfaces:**
- `recallEpisodes()` returns episode records that can be merged with existing `Memory` objects for prompt rendering.

- [ ] **Step 1: Add a test for `เมื่อเช้า` selecting only today's morning episodes and for ordinary semantic queries returning relevant episodes.**
- [ ] **Step 2: Run the test and verify FAIL.**
- [ ] **Step 3: Embed the user query once, recall existing semantic memories and episodic memories separately, and merge both into the existing synthetic `search_memory` result with `type: episodic` on episode rows.**
- [ ] **Step 4: Preserve the current semantic-memory relevance threshold and session isolation.**
- [ ] **Step 5: Run tests and `bun run typecheck`.**
- [ ] **Step 6: Commit** with `feat: recall episodic context in dialogue`.

### Task 5: Final verification

**Files:**
- No source changes unless verification exposes a defect.

- [ ] **Step 1: Run `bun run typecheck`.**
- [ ] **Step 2: Run `bun scripts/test-episodic.ts`.**
- [ ] **Step 3: Run existing `scripts/test-profile.ts` and repository tests available in the current tree.**
- [ ] **Step 4: Inspect the final diff and confirm no Gemini 1 `summery` contract or existing memory threshold was changed.**
- [ ] **Step 5: Commit any verification-only fix separately if needed.**
