# Docs Maintenance Guide

This directory is Sage's canonical project documentation. It is part of the repo and should evolve with code changes.

## Purpose

- Use `docs/` for durable project knowledge: architecture, module boundaries, development conventions, operations, design decisions, and incident reviews.
- Use `agent_home/memory/project_sage/` only as agent-facing hot context: short current facts, safety reminders, and pointers into `docs/`.
- Do not duplicate complete explanations in both places. When a topic grows, keep the full version in `docs/` and link to it from memory.

## Structure

```text
docs/
  README.md                    # This maintenance guide
  index.md                     # Human entry point and navigation
  development-conventions.md   # Rules for making code changes
  development-workflow.md      # Process control, prod/dev safety, and verification workflow
  operations.md                # Existing operations ledger guide
  architecture/
    overview.md                # System map
    boundaries.md              # Dependency and ownership rules
    core.md                    # SageCore, MessageGateway, HistoryStore
    providers.md               # AgentProvider and fallback semantics
    scheduler-operations.md    # Scheduler, workflow, Operations ledger
    apps.md                    # App layer and product domains
  apps/
    README.md                  # Rules for product-domain docs
    health.md                  # Health app boundaries and privacy rules
    rss.md                     # RSS app worker and generated-feed model
    investment/
      portfolio-checkup-mvp.md # Investment app product/technical roadmap
  decisions/
    README.md                  # ADR format and index
  incidents/
    README.md                  # Incident note format and index
```

## Writing Rules

- Write answer-first. Start each document with its scope and the current conclusion.
- Prefer stable facts over history. Move old narrative into `decisions/` or `incidents/`.
- Keep docs close to their owner:
  - Architecture and boundaries: `architecture/`.
  - Product-domain app docs: `apps/`.
  - Development rules: `development-conventions.md`.
  - Runbooks and operational behavior: `operations.md` or future `operations/`.
  - Why a major choice was made: `decisions/`.
  - What broke and what changed after it: `incidents/`.
- Do not create top-level folders for individual features. For app-specific durable docs, use `apps/{app}.md` or `apps/{app}/` when the app has multiple long-lived topics.
- Include code paths when they clarify ownership, but do not paste large code blocks.
- Do not store secrets, real tokens, cookies, private keys, DB dumps, uploads, or full private logs in docs.

## Update Triggers

Update docs in the same change when code changes affect:

- Module ownership or dependency direction.
- Public or local HTTP API behavior.
- Persistent schema, migrations, storage paths, or backup expectations.
- Product-domain app behavior, local data, privacy boundary, or user workflow.
- Provider/session/fallback behavior.
- Scheduler, workflow, proactive message, or Operations semantics.
- Security boundary, public exposure, uploads, shell execution, or file access.
- Required development workflow, test commands, or prod/dev process control.

If a related doc is intentionally not updated, call that out in the final handoff with the doc path and reason.

## Document Format

Use this lightweight format for new documents:

```md
# Title

Current conclusion in one short paragraph.

## Scope

What this document owns and what it does not own.

## Current Model

The durable current behavior or architecture.

## Rules

Hard constraints future changes must respect.

## Open Gaps

Known issues or deferred work, only if they are still relevant.
```

For decisions, use the ADR format in `docs/decisions/README.md`. For incidents, use the format in `docs/incidents/README.md`.
