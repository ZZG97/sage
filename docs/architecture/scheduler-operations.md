# Scheduler And Operations

Scheduler is Sage's proactive work engine. Operations is the run ledger that records whether background work actually completed.

## Scheduler Scope

`TaskScheduler` is the public scheduler façade. It owns:

- Builtin scheduled tasks.
- Dynamic `message`, `agent`, and `workflow` tasks.
- bunqueue registration and worker execution.
- One-shot and recurring schedules.
- Dispatch into message, agent, and workflow execution.

Scheduler implementation details live under `src/services/scheduler/`:

- `dynamic-task-repository.ts`: `dynamic_tasks` SQLite persistence and row serialization.
- `workflow-normalizer.ts`: workflow payload validation, normalization, and summary generation.
- `workflow-runner.ts`: linear workflow execution, run directory layout, result records, and agent prompt context.
- `workflow-shell-runner.ts`: shell step execution and stdout/stderr/meta artifacts.
- `scheduler-run-recorder.ts`: Operations run ledger integration.

Dynamic agent and workflow tasks may reuse an existing conversation through `reuseConversationId`.

## Workflow Model

Workflow v1 is linear:

```text
step 1 -> step 2 -> step 3
```

Step kinds:

- `shell`: executes a command, writes stdout/stderr/meta to a run output directory.
- `agent`: sends a prompt to Sage's agent runtime, with previous step artifact paths in context.

There is no DAG, branch, parallel execution, or per-step schedule yet.

## Operations Ledger

`OperationsService` stores run records in `data/operations.db`.

It tracks:

- Operation type/name.
- Trigger type.
- Status.
- Timing.
- Summary.
- Metrics.
- Error.
- Metadata.
- Request/trace IDs.
- Alert state.

Scheduler jobs are recorded automatically. Other long-running work should instrument Operations manually when basic scheduler coverage is not enough.

## Rules

- Scheduled work should produce an Operations record.
- Workflow shell steps must record artifacts and failure details.
- Agent task retries need idempotency rules before business-level retry is enabled.
- Proactive tasks that send Feishu messages must avoid duplicate root messages.

## Current Gaps

- Workflow execution policy is now split out of `TaskScheduler`, but v1 is still linear only.
- Shell execution needs stronger cwd, command, output-size, and retry boundaries before broader use.
- Operations is a ledger, not a full trace timeline.
- AI log inspection and conversation quality analysis are still future work.
