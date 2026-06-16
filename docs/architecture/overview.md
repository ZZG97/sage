# Architecture Overview

Sage is a private assistant runtime centered on Feishu messaging, local state, and multiple agent backends. The core design goal is to keep transport, provider, scheduler, and app-domain concerns separated.

## Runtime Map

```text
Feishu WebSocket
  -> FeishuService
  -> MessageContext
  -> SageCore
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

- `SageCore`: owns conversation identity, provider session routing, active runs, queueing, `/stop`, `/clear`, provider switching, and proactive agent execution.
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
- Provider abstraction supports multiple backends and lazy session restore.
- Scheduler uses persistent dynamic tasks and records runs into Operations.
- Apps are mounted under `/apps/{name}` and generally own their own service/repository boundary.

## Current Pressure Points

- `SageCore`, `FeishuService`, and `TaskScheduler` are large stateful modules and should be split only along established ownership boundaries.
- Provider reliability needs stronger timeout, circuit breaker, and explicit provider-session ownership.
- HTTP management/debug surfaces need a clear private-access policy before wider exposure.
- Storage and migration conventions are not yet centralized across all DB owners.
