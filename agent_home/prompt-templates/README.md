# System Prompt Editing Guide

This directory contains shared source material for generated agent prompt files.

`AGENTS.md` and `CLAUDE.md` are generated files. Do not edit them.

The contents of `SOUL.md`, `USER.md`, and `MEMORY.md` are rendered into `AGENTS.md`; re-render `AGENTS.md` after editing them.

## Source Of Truth

- Edit `prompt-templates/common.md` for long, stable rules that are identical in both prompts.
- Edit `prompt-templates/AGENTS-template.md` for rules that apply to every agent reading `AGENTS.md`.
- Edit `prompt-templates/CLAUDE-template.md` for Claude Code-only rules.
- Edit `prompt-templates/AGENTS-template.md` or `prompt-templates/CLAUDE-template.md` only for agent-specific differences. After changing one entry template, check whether the other needs some change.
- Do not edit generated `AGENTS.md` or `CLAUDE.md` directly.

## Boundaries

- `AGENTS.md` is generic. Do not add Codex-only wording such as "As Codex".
- `CLAUDE.md` is Claude Code-specific. Claude-only constraints belong there.
- Provider-specific rules should not be placed in `common.md`.
- Keep common content coarse-grained. Do not create tiny partials for short sections.
- Avoid generated comments or include markers in final prompt files; they are still prompt tokens.

## Memory Includes

- `AGENTS-template.md` uses normal `@memory/...` includes; the renderer expands them for agents that do not support Claude-style includes.
- `CLAUDE-template.md` uses escaped `@@memory/...` includes; the renderer preserves them as `@memory/...` so Claude Code can resolve them.
- Never render private memory content into tracked files.

## Validation

Run from repo root:

```bash
bun run sync:prompts
bun run check:prompts
```

Run from `agent_home/` when editing the renderer:

```bash
python3 -m py_compile scripts/render_agents.py
```
