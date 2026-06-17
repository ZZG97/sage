# App Layer

The app layer contains product-domain APIs mounted under `/apps/{name}`.

## Scope

Each app should own its routes, services, repositories, and domain types. Apps should not depend on each other by default.

Durable product-domain docs live under `docs/apps/`. Keep this file focused on app-layer architecture and cross-app rules.

Common pattern:

```text
src/apps/{app}/
  routes.ts
  service.ts
  repository.ts
  types.ts
```

Small apps may omit files they do not need.

## Current Apps

- `management`: provider/fallback status and scheduler management APIs.
- `operations`: run ledger summary and run list APIs.
- `debug`: read-only local DB browser.
- `health`: medical records, medications, and health metrics. See `docs/apps/health.md`.
- `investment`: portfolio tracking, holding import, and A-share price refresh. See `docs/apps/investment/portfolio-checkup-mvp.md` for the roadmap.
- `rss`: RSS AI worker support and generated AI feed routes. See `docs/apps/rss.md`.

## Rules

- Routes parse HTTP and call app services. Non-trivial business logic belongs below routes.
- Repositories own SQL and persistence details.
- App services should expose domain operations, not raw DB primitives.
- Cross-app reuse should go through `src/shared/` or a deliberate shared service.
- App HTTP surfaces that read private state or mutate state must stay behind the shared Sage HTTP auth middleware.
- Production startup fails closed when HTTP binds to a non-loopback host without a configured Sage HTTP token; explicit public binding remains valid only with auth configured.
- Generated RSS feeds under `/apps/rss/feeds/*` are currently a deliberate public exception for FreshRSS consumption; protect them separately with a feed-specific token if that exposure changes.

## Current Gaps

- Debug can read local DB tables and should remain local/private or be gated.
- Some app HTTP body parsing still uses loose types and should move toward boundary normalization.
