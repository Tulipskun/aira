# Truth-First Memory Integrity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent reflexive agreement and unsafe fact mutation by introducing confirmation-aware personal facts, explicit ownership checks, and truth-first prompt behavior while preserving historical episodic memory.

**Architecture:** Keep the existing SQLite profile as the authoritative store for current personal facts and keep Chroma/episodic memory as retrieval/history layers. Extend the structured Gemini-2 state result so fact proposals carry an owner and confirmation intent; make `applyTurnStateAtomic()` the final authorization boundary that only mutates the owner's current fact set when the owner explicitly confirmed the replacement. Strengthen Gemini 1 with a concise truth hierarchy, while relying on application checks rather than prompt-only enforcement.

**Tech Stack:** TypeScript, Bun SQLite, ChromaDB, Google GenAI structured output, existing Vitest/Node-style repository tests and GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-09-05-truth-first-memory-integrity-design.md`

## Global Constraints

- Application-authoritative context is higher priority than conversational claims.
- Existing confirmed personal facts must not be silently overwritten by conflicting claims.
- A personal fact write must be bound to the fact owner's `userId`.
- Another participant's statement cannot mutate that participant's profile without that owner's confirmation or an application-authoritative update.
- Historical episodic memory must remain available after a current-fact update.
- Do not redesign embeddings, Chroma retrieval, relationship-state rules, or the overall pipeline beyond what is required for ownership/confirmation safety.

---

### Task 1: Add failing regression tests for fact conflict and ownership

**Files:**
- Test: `scripts/test-memory-integrity.ts`
- Modify: `package.json` only if the repository has no suitable script entry for the new test

**Interfaces:**
- Consumes: `getUserProfile()`, `upsertUserProfile()`, `applyTurnStateAtomic()`, and the repository's existing SQLite isolation patterns.
- Produces: executable regression coverage for conflict retention, explicit replacement, third-party isolation, and historical preservation.

- [ ] **Step 1: Write the failing test harness**

Create a self-contained test script that uses a temporary `SQLITE_PATH`, imports the profile/turn-transaction modules after setting the environment, and resets the temporary database between cases. The script must assert these cases:

```ts
async function run() {
  await testConflictDoesNotOverwrite();
  await testExplicitOwnerConfirmationReplacesCurrentFact();
  await testThirdPartyClaimCannotChangeTargetProfile();
  console.log("test-memory-integrity: PASS");
}

async function testConflictDoesNotOverwrite() {
  // Arrange: Alice has the confirmed current fact "ชอบกินผัก".
  // Act: apply a new unconfirmed proposal "ไม่ชอบกินผัก" for Alice.
  // Assert: current confirmed fact remains "ชอบกินผัก" and the conflicting claim is not promoted to current fact.
}

async function testExplicitOwnerConfirmationReplacesCurrentFact() {
  // Arrange: Alice currently has "ชอบกินผัก" and then explicitly confirms "ไม่ชอบกินผักแล้ว".
  // Act: apply the confirmed replacement.
  // Assert: current fact is "ไม่ชอบกินผักแล้ว" and the old fact still exists in the historical fact record.
}

async function testThirdPartyClaimCannotChangeTargetProfile() {
  // Arrange: Bob has "ชอบกินผัก". Alice says "Bob ไม่ชอบกินผัก" in a shared session.
  // Act: attempt to apply the proposal as Alice's turn.
  // Assert: Bob's current fact remains unchanged and Alice's profile does not receive Bob's fact as an Alice fact.
}
```

The temporary database setup must run before importing the modules that initialize SQLite, for example by assigning `process.env.SQLITE_PATH` to a fresh temp directory and dynamically importing the modules inside each isolated process/test setup.

- [ ] **Step 2: Run the new test to prove it fails**

Run:

```bash
bun scripts/test-memory-integrity.ts
```

Expected: FAIL because the current implementation blindly adds a conflicting fact to `facts_json` and has no owner/confirmation distinction.

- [ ] **Step 3: Register the regression test**

Add the repository's existing test command entry (or a dedicated `test-memory-integrity` script if that is the established pattern) so CI can run:

```bash
bun scripts/test-memory-integrity.ts
```

- [ ] **Step 4: Run the test entry again**

Run:

```bash
bun scripts/test-memory-integrity.ts
```

Expected: the same assertion failures occur, confirming the test is actually exercising the current bug rather than being skipped.

- [ ] **Step 5: Commit**

```bash
git add scripts/test-memory-integrity.ts package.json
git commit -m "test: cover memory fact integrity"
```

---

### Task 2: Introduce confirmation-aware fact application in SQLite

**Files:**
- Modify: `src/sql/profile.ts`
- Modify: `src/sql/turn-transaction.ts`
- Test: `scripts/test-memory-integrity.ts`

**Interfaces:**
- Consumes: existing `UserProfile.facts`, `applyTurnStateAtomic()` transaction boundary, current `userId` keying.
- Produces: a fact proposal type and atomic application path that distinguishes ordinary claims from explicit owner-confirmed replacements.

- [ ] **Step 1: Add explicit fact metadata types**

Extend `UserFact` in `src/sql/profile.ts` with the minimum metadata necessary to distinguish current confirmed facts from historical entries without adding a second table:

```ts
export type UserFact = {
  text: string;
  timestamp: string;
  status?: "confirmed" | "historical";
};
```

Keep backward compatibility: facts loaded from older `facts_json` without `status` must hydrate as `confirmed`.

- [ ] **Step 2: Add a typed fact proposal contract**

In `src/sql/turn-transaction.ts`, define an internal/exported proposal type with exact ownership and confirmation fields:

```ts
type FactProposal = {
  text: string;
  ownerUserId: string;
  confirmedByOwner: boolean;
};
```

Change the atomic function signature to accept proposals rather than raw strings while preserving the existing call site's other state inputs.

- [ ] **Step 3: Write the minimal conflict algorithm**

Inside the existing `BEGIN IMMEDIATE` transaction, normalize old facts so missing `status` becomes `confirmed`. For each proposal:

```ts
const current = confirmedFactsMatchingMeaning(proposal.text, existingFacts);
if (current && !proposal.confirmedByOwner) {
  // Keep the confirmed current fact unchanged.
  // Do not append the conflicting proposal as a current confirmed fact.
  continue;
}

if (current && proposal.confirmedByOwner) {
  markCurrentAsHistorical(current);
  addAsConfirmed(proposal);
  continue;
}

addAsConfirmedIfNew(proposal);
```

Because the repository currently has semantic text rather than fact IDs, `confirmedFactsMatchingMeaning()` must initially use the model-provided relation between proposal and existing fact rather than attempting to invent an embedding-based semantic diff inside SQLite. Do not implement a second embedding pass in this task.

- [ ] **Step 4: Enforce owner authorization before mutation**

Only allow a proposal to alter the profile row selected by its `ownerUserId` when `confirmedByOwner === true` and that owner is the authenticated/current fact owner. The turn transaction must reject a proposal that targets a different `userId` without explicit owner confirmation rather than silently redirecting it to the speaker.

- [ ] **Step 5: Preserve historical facts**

When a confirmed fact is replaced, keep the old record with `status: "historical"` and retain its original timestamp. The current confirmed record gets the new event timestamp. Continue enforcing `MAX_FACTS` by trimming oldest historical entries only after current confirmed entries are preserved.

- [ ] **Step 6: Make legacy facts hydrate safely**

Update the parser/serializer so existing forms remain valid:

```ts
{ "text": "ชอบกินผัก", "timestamp": "..." }
```

must become an in-memory fact with `status: "confirmed"`, and serialization must include status only for new/updated records.

- [ ] **Step 7: Run focused regression tests**

Run:

```bash
bun scripts/test-memory-integrity.ts
```

Expected: conflict retention, explicit replacement, and historical preservation pass. The ownership test may still fail until Task 3 if the structured pipeline cannot yet produce owner-specific proposals.

- [ ] **Step 8: Commit**

```bash
git add src/sql/profile.ts src/sql/turn-transaction.ts scripts/test-memory-integrity.ts
git commit -m "feat: make personal facts confirmation-aware"
```

---

### Task 3: Make Gemini 2 emit ownership and confirmation intent

**Files:**
- Modify: `src/gemini/state-format.ts`
- Modify: the Gemini 2 system prompt file referenced by `config.paths.gemini2SystemPrompt`
- Modify: `src/pipeline/pipeline.ts`
- Test: `scripts/test-memory-integrity.ts`

**Interfaces:**
- Consumes: turn speaker identities, per-user profiles, current conversational transcript, and Task 2 fact proposal contract.
- Produces: structured fact proposals containing owner `userId` and `confirmedByOwner`, plus safe pipeline mapping into the SQLite transaction.

- [ ] **Step 1: Add failing schema assertions**

Extend the existing `ISLA_STATE_SCHEMA` with an explicit fact-proposal structure. The schema must allow zero or more proposals with these fields:

```ts
{
  "text": string,
  "owner_user_id": string,
  "confirmed_by_owner": boolean
}
```

The test must reject an output where a proposal omits `owner_user_id` or `confirmed_by_owner`.

- [ ] **Step 2: Update `parseIslaState()` to retain the fields**

Map the structured JSON fields to the parsed state without inferring a missing owner from the session. A missing or invalid owner must be treated as an invalid proposal and excluded from persistence, not defaulted to the current speaker when group context is present.

- [ ] **Step 3: Add explicit Gemini 2 analysis rules**

Update the analyzer prompt so it distinguishes:

```text
claim = a statement that is not an explicit confirmation of changing an existing personal fact
confirmed update = the owner explicitly confirms that the new value replaces the old fact
owner = the person whose personal fact is being asserted/changed, not automatically the latest speaker
```

For a statement such as Alice saying `Bob ไม่ชอบกินผัก`, emit no personal update for Bob unless Bob is the owner who explicitly confirms the change in the same context or the application supplied an authoritative update.

- [ ] **Step 4: Pass exact owner IDs into the atomic state application**

In `src/pipeline/pipeline.ts`, map the parsed proposals directly into the Task 2 proposal shape. Do not use the global session key as an identity substitute. The `owner_user_id` must be checked against `speakers`/known identities before application.

- [ ] **Step 5: Keep the speaker's relationship state unchanged**

Continue applying `affinity`, `isFlirt`, approvals, and relationship state to `message.userId`/turn owner as today. Fact ownership must be independent from relationship-state ownership.

- [ ] **Step 6: Run the full memory integrity test**

Run:

```bash
bun scripts/test-memory-integrity.ts
```

Expected: all fact conflict, confirmation, third-party isolation, and historical preservation assertions pass.

- [ ] **Step 7: Commit**

```bash
git add src/gemini/state-format.ts src/pipeline/pipeline.ts src/gemini/prompts src/gemini
git commit -m "feat: encode fact ownership and confirmation"
```

---

### Task 4: Strengthen Gemini 1 truth-first conversation behavior

**Files:**
- Modify: `src/gemini/prompts/isla.md`
- Test: `scripts/test-memory-integrity.ts`

**Interfaces:**
- Consumes: existing `<current_time>`, `<user_profile>`, `<group_session>`, and memory context blocks.
- Produces: a system prompt that explicitly prioritizes authoritative context and confirmed profile facts over casual claims without duplicating schema/application internals.

- [ ] **Step 1: Add failing prompt assertions**

Add assertions that the loaded `gemini1SystemPrompt()` contains the truth-first rules and does not expose implementation terms:

```ts
const prompt = gemini1SystemPrompt("Alice");
assert(prompt.includes("authoritative"));
assert(prompt.includes("confirmed"));
assert(prompt.includes("conflicting"));
assert(!prompt.includes("turn_state_applied"));
assert(!prompt.includes("ChromaDB"));
```

- [ ] **Step 2: Add the minimum truth hierarchy text**

Insert a focused section near the existing priority/memory rules:

```text
## Truth and conflicting claims
- Do not agree with a statement merely because {{partner}} said it.
- When authoritative context such as <current_time> conflicts with a user's claim, follow the authoritative context.
- A confirmed personal fact is stronger than a new unsupported claim about that same person.
- When a new claim conflicts with a confirmed personal fact, do not silently treat the new claim as true. Ask for clarification when needed.
- In a group, one person cannot change another person's personal fact just by saying it.
- A conversational claim may be historical context without becoming a confirmed personal fact.
```

Keep this shorter than a duplicate of the analyzer/schema. Do not mention internal table names, scoring, or transaction implementation.

- [ ] **Step 3: Add a deterministic truthfulness regression**

Add a prompt-level fixture documenting the morning case:

```text
<current_time>2026-09-05T09:00:00+07:00</current_time>
{{partner}}: สวัสดีตอนเย็น
```

The fixture is not a model-quality benchmark; it exists to ensure the system prompt explicitly instructs the model not to affirm the false time premise.

- [ ] **Step 4: Run prompt tests**

Run:

```bash
bun scripts/test-memory-integrity.ts
```

Expected: PASS for prompt assertions.

- [ ] **Step 5: Commit**

```bash
git add src/gemini/prompts/isla.md scripts/test-memory-integrity.ts
git commit -m "feat: enforce truth-first dialogue rules"
```

---

### Task 5: Verify group/global-session boundaries and episodic preservation

**Files:**
- Modify: `scripts/test-memory-integrity.ts`
- Inspect only unless required: `src/memory/chroma.ts`, `src/memory/episodic.ts`, `src/session-keys.ts`, `src/sql/sessions.ts`

**Interfaces:**
- Consumes: existing `sessionKey`, per-user Chroma metadata, current group identity blocks, and SQLite fact ownership.
- Produces: regression proof that shared sessions do not become cross-user write authority and that historical episodic records are unaffected by current-fact updates.

- [ ] **Step 1: Add a cross-user group-session test fixture**

Construct identities:

```ts
const alice = { userId: "alice", userName: "Alice" };
const bob = { userId: "bob", userName: "Bob" };
const sharedSession = "group:example";
```

Seed Bob with a confirmed fact, then submit an Alice-owned claim about Bob. Assert both profiles remain unchanged except for Alice's own confirmed state changes.

- [ ] **Step 2: Add prompt ownership assertions**

Assert that `identityBlockFor([aliceIdentity, bobIdentity], true, "alice")` labels each profile with its own `userId` and distinguishes the current addressee from another participant.

- [ ] **Step 3: Add Chroma ownership assertions without changing retrieval design**

Use the existing `Memory` contract to verify that a saved memory for Bob carries `userId: "bob"` and that a user-scoped filter cannot return it as an Alice-owned memory. Do not alter vector search semantics in this task.

- [ ] **Step 4: Add episodic preservation assertion**

Create or stub an existing episodic record representing the old fact, update the current SQLite fact, then assert the episodic record is still retrievable or still present in its backing store. The test must prove current-fact replacement does not call a deletion path for episodic history.

- [ ] **Step 5: Run all focused tests**

Run:

```bash
bun scripts/test-memory-integrity.ts
```

Expected: PASS for all truth, ownership, profile isolation, and historical assertions.

- [ ] **Step 6: Commit**

```bash
git add scripts/test-memory-integrity.ts
git commit -m "test: verify group isolation and history preservation"
```

---

### Task 6: Run repository-wide verification and inspect the final diff

**Files:**
- Inspect all files modified by Tasks 1-5

**Interfaces:**
- Consumes: all implemented changes.
- Produces: verified build/typecheck/test result and a final diff review with no unrelated edits.

- [ ] **Step 1: Run the targeted regression**

```bash
bun scripts/test-memory-integrity.ts
```

Expected: PASS.

- [ ] **Step 2: Run the repository test suite**

Use the package scripts from `package.json`; run the repository's normal unit/integration test command and all existing custom scripts. At minimum:

```bash
bun run typecheck
bun test
```

If one of these commands is not present, use the exact existing equivalent from `package.json` rather than inventing a new command.

- [ ] **Step 3: Inspect the diff for scope safety**

Confirm that:

```bash
git diff --check
```

reports no whitespace errors and that the changed files are limited to the truth/memory integrity feature.

- [ ] **Step 4: Verify the latest GitHub Actions run**

After the commits are pushed to `main`, inspect the latest workflow run and verify the typecheck and test jobs complete successfully before claiming completion.

- [ ] **Step 5: Commit any final test-only corrections**

Only if verification reveals a real defect, make the smallest correction, rerun the failing test, and commit with a specific fix message. Do not bundle unrelated refactors.
