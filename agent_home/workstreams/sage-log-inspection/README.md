# Sage Log Inspection

## Goal

Build a lightweight, low-noise loop for inspecting Sage logs and Operations
runs. The loop should find new error patterns, recurring known problems,
log-level mismatches, and watch-worthy transient failures without becoming an
automatic code-changing system.

## Scope

In scope:

- Read-only inspection of Sage PM2 logs and `Operations` run records.
- AI-assisted classification of recent `ERROR` / `WARN` evidence.
- A short Feishu-facing summary when useful.
- A local state ledger for known patterns, watch items, and next steps.

Out of scope for the first version:

- No automatic code edits.
- No service restart, stop, kill, or PM2 mutation.
- No new database or monitoring service.
- No raw log dumps in tracked files.
- No broad alerting for every warning line.

## Current Design

Use existing Sage primitives first:

1. A shell collection step gathers a bounded recent window from `Operations` and
   PM2 logs.
2. An agent step analyzes the collected output and replies with a concise
   summary.
3. The agent updates `state.md` only with sanitized conclusions.
4. Fixes require explicit Laozhang approval in a normal coding turn.

Do not add a dedicated built-in task or script until this manual workflow has
been useful several times.

## Dispositions

- `noise_or_bad_level`: The behavior is expected or harmless, but the log level
  may be too high. Record as a candidate; do not auto-edit.
- `fix_candidate`: Evidence points to a real bug. Ask before opening a fix.
- `watch`: Possibly real, but low-frequency or under-evidenced. Track recurrence.
- `no_action`: Known benign path, user interruption, or already-covered alert.

## Trigger

Manual first:

```text
跑一次 Sage 日志巡检
```

The first implementation should run as an ad hoc read-only inspection in this
thread. If it stays useful and low-noise, convert it to a dynamic Scheduler
workflow later.

Scheduler workflow draft:

- `scheduler-workflow.json` contains a ready-to-register dynamic workflow
  payload.
- The shell step collects bounded read-only evidence.
- The agent step reads this README and `state.md`, then replies with a concise
  Feishu-facing analysis.
- Register it only after Laozhang chooses the schedule. Suggested starting
  point: daily, not high-frequency.

## Safety

- Treat logs as sensitive.
- Quote only short, sanitized evidence.
- Prefer counts, components, operation names, request ids, and error classes over
  full user text.
- Never expose `agent_home/`, `memory/`, uploads, or workspace roots through a
  public server as part of this workflow.
- Never restart prod `sage` from this workstream.
