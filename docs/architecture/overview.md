# Architecture Overview

Sage is a private assistant runtime centered on Feishu messaging, local state, and multiple agent backends. The core design goal is to keep transport, provider, scheduler, and app-domain concerns separated.

## Runtime Map

```text
Feishu WebSocket
  -> FeishuService
  -> MessageContext
  -> SageCore
  -> AgentTurnRunner
  -> AgentProvider.sendMessageStream()
  -> provider SDK / local tools
  -> AgentEvent stream
  -> AssistantResponder
  -> Feishu card/text/file replies
```

HTTP apps run beside the Feishu flow:

```text
Hono WebServer
  -> src/apps/*
  -> app services/repositories
  -> SQLite / external adapters
```

Scheduled work runs through `TaskScheduler`:

```text
bunqueue scheduler
  -> builtin or dynamic task
  -> message / agent / workflow execution
  -> Operations run ledger
  -> optional proactive Feishu message
```

## Major Components

- `SageCore`: owns provider session routing, queueing, `/stop`, `/clear`, provider switching, proactive agent orchestration, and shutdown/restart lifecycle.
- `AgentTurnRunner`: owns one assistant turn's stream loop, active-run registration/cleanup, response update/complete lifecycle, idle timeout handling, and final session/resume/event persistence callbacks.
- `ConversationRouter`: owns external message/thread identity lookup, in-memory routing caches, and conversation binding to stable internal `conv_*` IDs.
- `MessageGateway`: transport-neutral messaging boundary used by Core.
- `FeishuService`: production gateway implementation for Feishu events, rich media, streaming cards, uploads, and replies.
- `AgentProvider`: provider abstraction for Codex, Claude Code, CC-MiniMax, OpenCode, and fallback.
- `HistoryStore`: SQLite-backed conversation and event history.
- `TaskScheduler`: builtin tasks, dynamic message/agent/workflow tasks, and scheduler persistence.
- `OperationsService`: run ledger for scheduled and long-running work.
- `src/apps/*`: app-domain APIs such as management, operations, health, RSS, investment, and debug.

## Current Strengths

- Core no longer depends directly on Feishu card JSON; it speaks semantic response lifecycle through `AssistantResponder`.
- Internal conversation IDs are stable `conv_*` IDs; Feishu message/thread IDs are external lookup fields.
- Provider abstraction supports multiple backends, lazy session restore, and durable provider-session ownership.
- Scheduler uses persistent dynamic tasks and records runs into Operations.
- Apps are mounted under `/apps/{name}` and generally own their own service/repository boundary.
- SQLite schemas and structural migrations are centralized in `src/shared/db-migrations.ts`.
- Private HTTP surfaces are gated by Sage HTTP Bearer auth for management/debug/health/investment/operations/scheduler/uploads paths.

## Current Pressure Points

- `SageCore`, `FeishuService`, and `TaskScheduler` are large stateful modules and should be split only along established ownership boundaries.
- Provider reliability needs stronger timeout, circuit breaker, and richer provider error classification.
- Storage backup and restore conventions still need a dedicated operator runbook.
