# Truth-First Memory Integrity Design

**Date:** 2026-09-05
**Status:** Approved architecture, pending implementation

## Goal

Make Isla truth-first rather than reflexively agreeing with the latest user claim, preserve previously confirmed user facts until the same user explicitly confirms a correction, and prevent facts from one user being changed or attributed through a shared/global session.

## Problem

The current prompt already says that retrieved memories are similarity matches rather than proof and that group identities are separate, but facts extracted from Gemini 2 are currently written directly into the speaker's profile. `applyTurnStateAtomic()` deduplicates fact text but has no concept of a conflict, a confirmation, or the subject of a fact. Therefore a later contradictory claim can become a new fact without explicitly superseding the older one, and application-layer protection must be strengthened so a statement about another person cannot mutate that person's profile merely because the statement appeared in a shared session.

## Invariants

1. Authoritative context wins over unsupported user claims.
2. `<current_time>` and other application-supplied authoritative context are higher-priority facts than a user's casual assertion.
3. A latest user statement is a claim unless the application has an explicit confirmation/update signal for an existing fact.
4. An existing confirmed fact must not be overwritten solely because a new extracted fact conflicts with it.
5. A fact update requires explicit confirmation from the owner of that fact, or an equally authoritative application signal. In normal conversation, another participant cannot update someone else's personal fact.
6. Facts are owned by `userId`; speaker identity and fact subject must remain separate concepts.
7. In group/global sessions, retrieval may use shared conversation/episode context where appropriate, but personal facts shown in a user's profile must remain scoped to that user's `userId`.
8. Updating a fact does not erase the historical episodic memory of the earlier state.
9. The model must not reveal internal memory/conflict/scoring/storage mechanisms.
10. The implementation must enforce these rules in application state/memory handling as well as in the Gemini prompt; prompt-only enforcement is insufficient.

## Truth hierarchy

When sources disagree, use this order unless a higher-level application rule explicitly says otherwise:

1. Application-authoritative context (for example `<current_time>`).
2. Existing confirmed personal facts/profile for the relevant `userId`.
3. Existing relationship/state controlled by the application.
4. Current conversation claims from the relevant speaker.
5. Similarity-retrieved semantic memory that is not already established as a confirmed personal fact.
6. Model inference or guesswork.

The hierarchy is used to prevent false agreement. It does not require Isla to argue with the user unnecessarily; she should simply avoid affirming a false premise when authoritative context contradicts it.

## Fact lifecycle

A personal fact has one of three logical states:

- **confirmed**: accepted as the current user fact and eligible to be used as authoritative personal context.
- **conflict/claim**: a new statement conflicts with a confirmed fact or is otherwise not sufficiently confirmed. It must not replace the confirmed fact.
- **confirmed update**: the user explicitly confirms that the old fact is no longer true or that the new fact is the replacement. The replacement becomes the confirmed current fact, while the old fact remains available as history rather than being silently erased.

The existing profile format may retain its compact `facts_json` representation, but the update path must distinguish conflict from confirmed replacement. The implementation should prefer the smallest compatible schema change rather than introducing an unrelated memory system.

## Confirmation semantics

The implementation should treat these as examples, not exhaustive keyword rules:

- Existing fact: `ชอบกินผัก`; user says `ตอนนี้ไม่ชอบกินผักแล้ว` -> conflict/claim; do not replace automatically.
- User then explicitly confirms the correction, such as `ใช่ เปลี่ยนแล้ว`, `ไม่ชอบแล้วจริง ๆ` in direct response to the conflict -> confirmed update; replace the current fact with the new fact.
- User A says `B ไม่ชอบกินผัก` -> this may be a conversational claim about B, but it must not mutate B's profile. B must confirm the change, or the application must provide an authoritative update.

The model may ask a short clarification when a new claim conflicts with a confirmed fact, but should not expose internal terms such as `conflict`, `confirmed`, `profile`, or `memory score`.

## Ownership and global-session isolation

All personal-fact writes must resolve an owner before persistence. The owner defaults to the current authenticated/speaker user only when the extracted fact is clearly self-referential. A fact about another named participant must carry that participant's `userId` when such identity is unambiguous; otherwise it remains a conversational claim and is not written to a personal profile.

For retrieval and prompt construction:

- `profileBlock()` remains personal to the profile's `userId`.
- Group identity blocks may include multiple profiles, but no profile facts may be copied from one identity into another.
- Chroma memories retain their existing `userId` and `sessionKey` metadata.
- Shared/global-session retrieval must not be used as permission to write a personal fact to a different `userId`.
- Any update operation must verify the target `userId` instead of trusting only the session owner or the latest speaker.

## Gemini prompt behavior

`src/gemini/prompts/isla.md` should make the following explicit without duplicating the application implementation:

- Do not agree with a user simply because they said something.
- Treat authoritative context and confirmed profile facts as stronger than conversational claims.
- When a current claim contradicts an existing confirmed fact, do not silently overwrite it.
- Ask for confirmation when necessary and keep the old fact authoritative until confirmation arrives.
- A speaker cannot change another person's personal facts merely by asserting them in a shared conversation.
- A user's statement can still be remembered as an event/claim in episodic history without becoming a confirmed personal fact.

The prompt should not restate implementation details already guaranteed by schema/application validation.

## Application changes

Expected implementation areas:

- `src/sql/profile.ts`: represent confirmed personal facts in a way that can support safe replacement while keeping historical information available.
- `src/sql/turn-transaction.ts`: stop unconditional fact insertion for contradictory updates; add ownership/confirmation-aware fact application in the same atomic transaction that already protects turn state.
- `src/gemini/state-format.ts` and the Gemini 2 analysis prompt/schema: expose only the minimum structured information needed to distinguish a proposed fact claim from an explicitly confirmed update and identify its owner when unambiguous.
- `src/pipeline/pipeline.ts`: pass speaker/identity context into fact application and ensure a group statement about another user cannot be persisted as the current speaker's fact or directly mutate another profile without valid ownership/confirmation.
- `src/gemini/prompts/isla.md`: add the truth hierarchy and conflict behavior for the user-facing model.
- Tests should cover time truthfulness, fact conflict retention, explicit correction, cross-user isolation, and preservation of episodic history.

## Non-goals

- Do not redesign Chroma retrieval or embedding models.
- Do not remove episodic memories when a fact is updated.
- Do not turn Isla into an argumentative fact-checking assistant; truth-first behavior should be conversational and proportional.
- Do not infer third-party personal facts from another user's statement as if they were confirmed.
- Do not expose internal state or implementation mechanics in user-facing replies.

## Acceptance criteria

1. With authoritative morning context, a user saying `สวัสดีตอนเย็น` does not cause Isla to affirm that it is evening.
2. A confirmed personal fact remains authoritative when a later turn produces a conflicting claim.
3. An explicit confirmation by the fact owner causes the new fact to become current.
4. The previous fact remains available as historical context rather than being silently destroyed.
5. A statement by user A about user B cannot change B's personal profile in a shared/global session without B's confirmation or an application-authoritative update.
6. Retrieval/prompt assembly never labels B's personal fact as A's fact.
7. Existing relationship-state and episodic-memory behavior remains intact except where required by the ownership/confirmation rules above.
8. Regression tests fail before the implementation and pass afterward.
