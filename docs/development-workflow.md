# Development Workflow

This is the canonical process and runtime workflow for developing Sage. It covers process control, prod/dev safety, logging, and verification. `README.md` may summarize this workflow, but this file owns the full command and safety rules.

## Required Reads

Before modifying code under `~/workspace/sage/src/`, read these files. Paths are relative to repo root `~/workspace/sage` unless noted:

- `agent_home/memory/project_sage/index.md` for current hot context and routing.
- `docs/development-conventions.md` for code organization and completion rules.
- `docs/development-workflow.md` for runtime, process, and verification rules.

If the current working directory is `agent_home/`, the memory path is `memory/project_sage/index.md`, and the docs paths are under `../docs/`.

Then load the narrowest relevant architecture doc or memory detail for the module being changed.

## Process Model

PM2 owns both managed Sage instances:

- `sage`: production, normally port `3000`.
- `sage-dev`: development/test instance, normally port `3001`.

Both launch through `scripts/launch-sage.ts`, which parses `.env` or `.env.dev`, injects `SAGE_INSTANCE` and `PROCESS_NAME`, and guards obvious prod/dev mismatches.

Prefer package scripts over raw PM2 commands.

## Commands

Managed instance commands:

```bash
bun run dev:restart
bun run dev:logs
bun run dev:status
bun run prod:restart
bun run prod:logs
bun run prod:status
```

Do not use `bun run dev` or `bun run start` to manage the service in normal agent work. Those are raw launch commands used by the PM2 ecosystem and can create port conflicts.

## Hard Safety

Never restart, stop, kill, delete, or otherwise touch prod `sage` from a live Sage/Feishu conversation unless Laozhang explicitly approves that final step.

Prod restart can replace the runtime carrying the current conversation and lose continuity. Finish code, docs, and memory first; report ready state; then ask for restart approval.

Do not run `kill`, `pm2 stop sage`, or `pm2 delete sage` without explicit owner approval.

## Sage-Dev

`sage-dev` restart/stop/delete/logs are safe only in an isolated Sage self-iteration loop.

In ordinary user conversations or when runtime ownership is unclear, prepare changes and avoid process operations. When testing runtime behavior, use `sage-dev` only and ignore prod Feishu traffic.

Current `sage-dev` default is Codex with a cheaper model. Check `.env.dev` for exact values instead of assuming model names.

## Background Flow Policy

Background flows include scheduled tasks, proactive inspections, log reviews, and other non-interactive agent runs that are not a direct owner-approved implementation session.

By default, background flows may inspect, summarize, classify, and record. They may write scoped run records, reports, workstream notes, or other explicitly expected artifacts for the flow.

Background flows must not make code changes, perform external side effects, change broad runtime behavior, or restart prod `sage`. If a background flow discovers that any of those actions are needed, it should report the finding and leave the action as an explicit owner-approved follow-up.

## HTTP Context

Agent subprocesses inherit Sage runtime env, but shell profiles can shadow variables.

Skills calling Sage HTTP APIs should use the Agent-side helper so base URL and auth stay consistent:

```bash
bun ~/workspace/sage/agent_home/scripts/sage-api.ts GET /scheduler/tasks
bun ~/workspace/sage/agent_home/scripts/sage-api.ts POST /scheduler/tasks --json '{"kind":"message","message":"...","triggerAt":1712345678000}'
```

The helper reads `SAGE_API_BASE_URL` first, then falls back to `http://localhost:$PORT`, then `http://localhost:3000`. It sends `SAGE_INTERNAL_HTTP_TOKEN` or `SAGE_HTTP_TOKEN` as a Bearer token. Do not rely on raw `$PORT` or localhost bypasses in shell snippets when the command may run under a different shell/profile context.

## Logging

`src/utils/request-context.ts` uses AsyncLocalStorage.

Expected request context:

- HTTP inherits and returns `X-Request-Id`.
- Feishu and scheduler create request IDs.
- SageCore patches context after resolving conversation, message, session, provider, task, and run identifiers.
- Logs include compact request context fields such as `rid`, `src`, `conv`, `msg`, `sid`, `provider`, `task`, `run`, `kind`, `method`, and `path` when present.

PM2 timestamps logs. `.env` and `.env.dev` can set `SAGE_LOG_TIMESTAMP=false` to avoid duplicate timestamps in Sage's own logger.

## Feishu Event Rule

Feishu long-connection event handlers must ACK quickly. Do not await full agent processing in the Feishu event handler.

Full processing should run in the background to avoid Feishu redelivery. Dedup uses:

- L1 memory cache in the Feishu adapter.
- L2 SQLite `processed_events`.
- Keys such as `event:<event_id>` and `message:<message_id>`, with legacy bare event-id compatibility where needed.

## Normal Code Flow

1. Read the required docs and relevant project memory.
2. Inspect the current code before designing the change.
3. Make scoped edits.
4. Run focused tests or typecheck appropriate to the risk.
5. Update docs or memory if current behavior changed.
6. Report what changed, how it was verified, and whether an owner-controlled restart is needed.

## Testing Bias

Prefer `bun:test` for pure functions, local renderers, repositories, and Core message flows.

For SageCore message behavior, inject `MessageContext` and use `InMemoryMessageGateway` instead of driving Feishu Web.

SQLite service tests should use temp or in-memory DBs, not `data/*.db`.

Feishu/provider/browser/system tests belong in manual scripts or explicit E2E flows. Keep real Feishu tests as adapter smoke or final verification, not default unit coverage.

## Code Research

For complex codebases, clone into `agent_home/workspace/projects/` and read locally instead of relying on web snippets.
