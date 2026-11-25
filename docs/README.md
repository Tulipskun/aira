# Documentation index

These documents describe the current Aira implementation. When a document and the running code disagree, verify the code and update the document rather than treating old notes as authoritative.

## Repository-level policies

- [Security policy](../SECURITY.md) — responsible vulnerability reporting and private runtime data.

## Current system documentation

- [Installation](installation.md) — prerequisites, one-command setup, Discord permissions and runtime files.
- [Architecture](architecture.md) — request flow, persistence boundaries, supervisor and system components.
- [Discord](discord.md) — channel selection, Control Panel, prefix commands, slash commands and sessions.
- [Gemini](gemini.md) — model roles, API-key rotation, embeddings and thought signatures.
- [Pipeline](pipeline.md) — ordered request/response stages and atomic state application.
- [Memory](memory.md) — retrieval, ingestion, isolation and timestamps.
- [SQL](sql.md) — SQLite tables, profiles, sessions and transaction guarantees.
- [Scheduler](scheduler.md) — per-session batching and flush rules.
- [Characters](../characters/README.md) — character definition format and multi-character behavior.

## Historical engineering notes

`superpowers/plans/` and `superpowers/specs/` contain dated plans and design records from earlier implementation work. Their checkboxes and proposed designs are historical snapshots; they do not necessarily describe outstanding work or the current implementation. Use the current system documents above and the source code for present-day behavior.
