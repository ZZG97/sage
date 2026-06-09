# Sage

Sage is Laozhang's private AI assistant on Feishu. It runs on the Mac mini, receives Feishu messages, streams replies through Feishu cards, can use multiple agent providers, and exposes a small web dashboard for operations, scheduler, health records, RSS AI, and debugging.

This repo is a private working system, not a generic SaaS starter. Treat process control, local files, credentials, and public exposure conservatively.

## Current Shape

Main flow:

```text
Feishu WebSocket
  -> FeishuService
  -> SageCore
  -> AgentProvider.sendMessageStream()
  -> AI backend
  -> streaming Feishu card updates
```

Provider backends:

- `codex`: OpenAI Codex SDK provider.
- `claude-code`: Claude Code SDK provider.
- `cc-minimax`: Claude Code SDK against MiniMax Anthropic-compatible API.
- `opencode`: OpenCode provider.

App layer:

- `/apps/management`: provider, fallback, scheduler management.
- `/apps/operations`: run ledger and health alerts.
- `/apps/health`: medical records, medication, health metrics.
- `/apps/rss`: RSS AI worker and generated RSS feeds.
- `/apps/debug`: local debug data browser.

Frontend lives in `web/` and is served from `web/dist/` when built.

## Repo Layout

```text
src/
  agent/          AgentProvider implementations and fallback wrapper
  apps/           app-domain APIs: debug, health, management, operations, rss
  config/         env-driven config
  services/       SageCore, Feishu, web server, scheduler, history store
  shared/         shared DB helpers
  utils/          logging, errors, request context
web/              Vite + React dashboard
docs/             stable project docs
agent_home/       agent context, generated prompts, memory symlink, skills
scripts/          launch wrapper and operational scripts
```

Long-lived agent memory is not stored directly in this repo. `agent_home/memory` points to `~/workspace/sage-data/memory`.

## Runtime

Sage is managed by PM2:

- `sage`: production, normally port `3000`.
- `sage-dev`: development/test instance, normally port `3001`.

Both processes launch through `scripts/launch-sage.ts`, which loads `.env` or `.env.dev`, injects instance/process metadata, and guards obvious prod/dev mixups.

Use PM2 package scripts for managed instances:

```bash
bun run dev:start
bun run dev:restart
bun run dev:logs
bun run prod:restart
bun run prod:logs
```

`bun run dev` and `bun run start` are raw launch commands used by the PM2 ecosystem. Agents should not use them to start another service instance, because that can create port conflicts.

Prod restart is owner-controlled. From a live Sage/Feishu conversation, do not restart or stop `sage` unless Laozhang explicitly approves that final step.

## Development

Install dependencies:

```bash
bun install
cd web && bun install
```

Build the dashboard:

```bash
cd web && bun run build
```

Run checks:

```bash
bun run typecheck
bun run test
```

Focused tests live near source files as `*.test.ts`. Tests should avoid real Feishu, real AI providers, production SQLite DBs, and external network by default. Manual/E2E probes belong under `scripts/manual/`.

## Configuration

Copy `.env.example` to `.env` or `.env.dev` and fill the relevant provider credentials.

Required:

- `FEISHU_APP_ID`
- `FEISHU_APP_SECRET`
- `AGENT_PROVIDER`

Common optional groups:

- Codex: `OPENAI_API_KEY`, `CODEX_MODEL`, `CODEX_WORK_DIR`, `CODEX_SANDBOX_MODE`.
- Claude Code: `CLAUDE_CODE_WORK_DIR`, `CLAUDE_CODE_MODEL`, `CLAUDE_CODE_ALLOWED_TOOLS`.
- CC-MiniMax: `CC_MINIMAX_API_KEY`, `CC_MINIMAX_MODEL`, `CC_MINIMAX_BASE_URL`.
- OpenCode: `OPENCODE_BASE_URL`.
- Proactive tasks: `OWNER_OPEN_ID`.
- RSS, maps, weather: see `.env.example`.

Prefer `HOST=127.0.0.1` for local/private deployments. Expose services through Tailscale or a narrowly scoped tunnel rather than binding broad local services publicly.

## Key Docs

- `agent_home/memory/project_sage/index.md`: second-level Sage memory router.
- `agent_home/memory/project_sage/dev_workflow.md`: required context before `src/` edits.
- `docs/operations.md`: Operations ledger and instrumentation guide.
- `agent_home/prompt-templates/README.md`: prompt generation rules.

Generated `agent_home/AGENTS.md` and `agent_home/CLAUDE.md` are ignored by git. Edit prompt templates and run:

```bash
bun run sync:prompts
bun run check:prompts
```
