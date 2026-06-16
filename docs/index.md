# Sage Docs

Sage is Laozhang's private Feishu-based AI assistant. These docs are the repo-level source of truth for architecture, development conventions, and operational behavior.

## Start Here

- [Development Conventions](development-conventions.md): rules for making Sage changes safely and consistently.
- [Development Workflow](development-workflow.md): process control, prod/dev safety, logging, and verification workflow.
- [Architecture Overview](architecture/overview.md): high-level runtime map and major components.
- [Architecture Boundaries](architecture/boundaries.md): ownership and dependency rules.
- [Docs Maintenance Guide](README.md): how this documentation set is organized and updated.

## Architecture

- [Core](architecture/core.md): `SageCore`, conversation identity, `MessageGateway`, and history storage.
- [Providers](architecture/providers.md): provider abstraction, session semantics, Codex, Claude Code, CC-MiniMax, OpenCode, and fallback.
- [Scheduler And Operations](architecture/scheduler-operations.md): builtin tasks, dynamic tasks, workflow, proactive messages, and run ledger.
- [Apps](architecture/apps.md): app-layer layout and current product domains.

## Product Domains

- [App Domain Docs](apps/README.md): how app-specific docs are organized.
- [Health](apps/health.md): personal health record app boundaries and privacy rules.
- [RSS](apps/rss.md): RSS AI worker, generated feeds, and RSS/FreshRSS boundary.
- [Investment Portfolio Checkup MVP](apps/investment/portfolio-checkup-mvp.md): roadmap for evidence-backed portfolio checkups.

## Operations

- [Operations Observability](operations.md): run ledger, metrics, health alerts, and instrumentation rules.

## Design History

- [Decisions](decisions/README.md): ADR index and format.
- [Incidents](incidents/README.md): incident review index and format.

## Relationship To Memory

`agent_home/memory/project_sage/` is an agent hot cache and router. It should point here for durable explanations instead of duplicating full architecture docs.
