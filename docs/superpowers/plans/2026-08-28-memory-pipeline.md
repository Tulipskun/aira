# Historical Memory Pipeline Plan

> Superseded by the current architecture documented in `README.md`, `docs/architecture.md`, `docs/pipeline.md`, and `docs/memory.md`.

This document records the original design from 2026-08-28. The implementation has since changed in several important ways:

- Gemini 1 remains the user-facing dialogue stage.
- Gemini 2 is now a post-response analyzer that returns one flat JSON state object; it does not execute a state-change tool.
- Relationship/profile state is derived and written by application code from Gemini 2 signals and SQLite state.
- Relevant memories are represented as a temporary request-local context for Gemini 1 and are never persisted as fake interaction steps.
- New semantic memory and episodic writes run as best-effort background work after the response path.
- Thought signatures are kept in a bounded in-memory cache and persisted only after inactivity or graceful shutdown.
- 429 rotates the stage-specific API-key pool; 5xx retries with backoff using the same key.

For the current contracts and runtime ordering, use the documents listed above rather than this historical plan.
