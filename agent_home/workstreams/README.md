# Agent Workstreams

Workstreams are long-running agent-owned work areas. They are lighter than apps
or product features, but more stateful than skills.

Use a workstream when a topic needs repeated investigation, a local state ledger,
and a small operating loop. Do not create one for a single TODO or for stable
how-to instructions that belong in a skill.

## Placement

- `memory/`: compressed long-term facts and cross-task context.
- `agent_home/workstreams/`: active workstream state, decisions, lightweight
  scripts, and sanitized result summaries.
- `agent_home/workspace/`: external repos, uploads, raw outputs, and scratch
  artifacts.
- `docs/` or repo code: stable developer-facing documentation and product code.

## Minimal Shape

```text
agent_home/workstreams/<name>/
├── README.md     # Goal, scope, trigger, operating loop
├── state.md      # Current status, known patterns, next step
└── .gitignore    # Raw artifacts and temporary output
```

Add `scripts/`, `results/`, or extra ledgers only after the workstream proves it
needs them. Prefer the smallest useful structure.

## Update Rule

Keep workstream state local to the task. Promote only stable conclusions back to
`memory/` after they become broadly useful across future tasks.
