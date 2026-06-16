# App Domain Docs

This directory holds durable documentation for Sage product-domain apps under `src/apps/`.

## Scope

Use this directory when an app has durable product behavior, local data, user workflow, external integrations, or safety rules that should survive beyond one implementation session.

Do not create an app doc for every small feature. Small features should stay in code, tests, `docs/architecture/apps.md`, or the relevant skill docs.

## Structure

- Use `docs/apps/{app}.md` for a compact app overview.
- Use `docs/apps/{app}/` only when one app has multiple long-lived topics.
- Keep operational how-to steps in skills when they are agent procedures rather than durable system design.
- Keep hot runtime state, credentials notes, and short-term source quality observations in memory.

## Current Docs

- [Health](health.md): personal health record app boundaries and privacy rules.
- [RSS](rss.md): Sage RSS AI worker, generated feeds, and RSS/FreshRSS boundary.
- [Investment Portfolio Checkup MVP](investment/portfolio-checkup-mvp.md): investment app roadmap for evidence-backed portfolio checkups.
