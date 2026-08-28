# Memory Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build the request pipeline that enriches Gemini1 with Chroma memories and SQL relationship state, returns Gemini1 text first, then runs Gemini2 background analysis and persists its memory/stat results.

**Architecture:** SQL is the source of truth for conversation history and relationships. Gemini Embedding 2 creates vectors for Chroma long-term memory search/write. Gemini1 receives relationship data in `system_instruction` and Chroma results as a temporary fake `search_memory(username)` call/result. Gemini2 receives the completed Gemini1 context and is forced to call the single `execute` tool; its result is processed asynchronously after the user response is returned.

**Tech Stack:** Bun, TypeScript, `bun:sqlite`, ChromaDB, `@google/genai`, Gemini Interactions API.

**Spec:** `gemini/README.md`, `sql/README.md`, `memory/README.md`

## Global Constraints

- Discord `user_id` is internal and never sent to Gemini.
- SQL stores conversation history and relationship state.
- SQL history stores filename only; it does not store file contents or URIs.
- Chroma stores long-term memories with Gemini Embedding 2 vectors.
- Fake tool calls/results are temporary and never persisted to SQL.
- Gemini1 produces the user-facing response.
- Gemini2 is forced to use the single `execute` tool for background state changes.
- No streaming mode.
- No debug mode.
- 429 rotates API keys; 5xx retries with backoff using the same key.

### Task 1: Gemini request primitives

**Files:** `gemini.ts`

- Add system instructions to request options using the Interactions API `system_instruction` field.
- Add typed temporary interaction steps for fake `function_call`/`function_result` context.
- Add helpers to create a one-shot fake tool call/result with an auto-generated call id.
- Keep temporary steps out of SQL.
- Preserve separate Gemini1/Gemini2 model/key pools and retry behavior.

### Task 2: Pipeline orchestration

**Files:** `pipeline.ts`, `pipeline/README.md`

- Save incoming user message to SQL.
- Load SQL history and create the Gemini context.
- Embed the new text and search Chroma.
- Load relationship records for the supplied related Discord user IDs.
- Build relationship `system_instruction` without Discord IDs.
- Add Chroma results as temporary `search_memory(username)` fake call/result.
- Call Gemini1.
- Save Gemini1 response to SQL and return it immediately.
- Start Gemini2 processing asynchronously.
- Gemini2 receives the completed context and is forced to call `execute`.
- Parse/validate execute commands, embed memory commands, update Chroma, and update relationship stats in SQL.

### Task 3: Documentation

**Files:** `gemini/README.md`, `sql/README.md`, `memory/README.md`, `pipeline/README.md`

- Document the final data flow and the separation between persistent state and temporary Gemini context.

### Verification

- Run `bun run typecheck`.
- Verify no Discord `user_id` appears in Gemini input or system instructions.
- Verify fake memory context is not written to SQL.
- Verify Gemini1 result is returned before background Gemini2 work completes.
- Verify Gemini2 output can update Chroma and SQL relationship state.
