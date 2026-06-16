# Development Conventions

These are Sage's hard development rules. They exist to keep code changes predictable as the project grows.

## Scope

This file governs code organization, dependency direction, side-effect boundaries, input handling, testing, and completion criteria. It does not replace runbooks, architecture details, or incident reviews.

## Module Ownership

Before adding code, choose the narrowest owner:

- `src/services/core.ts`: conversation/session/run state machine only.
- `src/services/message-gateway.ts`: transport-neutral inbound/outbound assistant messaging contract.
- `src/services/feishu.ts`: Feishu adapter details: event payloads, cards, PATCH, uploads, replies, rich media.
- `src/agent/`: provider abstraction and provider-specific SDK adapters.
- `src/apps/{name}/`: product-domain API, service, repository, and app-specific types.
- `src/shared/`: cross-app infrastructure with stable APIs, such as shared DB helpers.
- `scripts/`: operator or batch scripts, not imported runtime business logic unless deliberately designed as a library.

If a change does not fit one owner, split it instead of widening an existing module by convenience.

## Dependency Direction

- Core may depend on provider interfaces and `MessageGateway`, not Feishu-specific details.
- Providers must not know Feishu, Hono routes, or app-specific product domains.
- Apps should not depend on each other by default. Shared behavior belongs in `src/shared/` or a deliberately named service.
- Routes should parse HTTP and call services; they should not own business state machines.
- Adapter payload quirks must be normalized at the boundary before entering core or app services.

## Side Effects

These side effects must be isolated behind explicit services or capabilities:

- Feishu sends, card patches, uploads, reactions, and resource downloads.
- Provider calls, session restore, fallback, and structured agent runs.
- SQLite writes and migrations.
- Shell execution and external command invocation.
- File upload/download, local artifact publication, and path-based file sending.
- Process control, PM2 actions, restarts, and scheduler registration.

Do not hide side effects inside helper functions with neutral names. A caller should be able to tell that a method can send, write, execute, or publish.

## Input Normalization

External inputs must be normalized and validated before internal use:

- HTTP request bodies.
- Feishu event payloads and rich media content.
- Provider stream events and metadata.
- Scheduler dynamic task payloads.
- Workflow definitions and config from env vars.

Internal code should operate on typed domain objects, not raw external payloads. Use `unknown` at boundaries when possible; avoid passing raw `any` inward.

## State And Storage

- Persistent IDs must have a clear owner and lifecycle. Do not overload external message IDs as internal identity.
- SQLite schema definitions and structural migrations belong in `src/shared/db-migrations.ts`; services and repositories should call the centralized runner rather than owning DDL inline.
- Schema changes need a clear migration path and should be documented when they affect durable data.
- App data belongs to the app's repository/service boundary. Cross-app data access should be deliberate and documented.
- Do not read or write production DBs in tests. Use temp or in-memory DBs.

## Testing Rules

Add focused tests when a change touches:

- Conversation/session routing or active-run behavior.
- Provider session, resume, fallback, or timeout behavior.
- MessageGateway or Feishu responder lifecycle.
- SQLite schema, migration, repository, or query semantics.
- Scheduler registration, dynamic tasks, workflow, retries, or Operations status.
- HTTP route parsing for mutating endpoints.
- File publication, upload replacement, or local path handling.

Use `bun:test` for pure services and state machines. Avoid real Feishu, real providers, production DBs, and external network in automated tests unless the test is explicitly manual or E2E.

## Completion Criteria

Every non-trivial change should be able to answer:

- Which module owns this behavior?
- What new side effects were introduced?
- What inputs were normalized at the boundary?
- What tests or checks were run?
- Which docs or memory files became stale, and were they updated?
- Does prod need an owner-controlled restart?

If any answer is unclear, the change is not complete.
