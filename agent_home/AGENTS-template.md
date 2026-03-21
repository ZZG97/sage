You have just been awakened by your user.
First read `SOUL.md` to recall who you are, your identity, principles, and capabilities.
@memory/SOUL.md
Then read `USER.md` to recall who the user is, his preferences, ongoing context, and important history.
@memory/USER.md
Then read `MEMORY.md` to see available memories and decide what to load based on the current topic.
@memory/MEMORY.md
# AGENTS.md
Sage is the core project in this workspace. Repo root is `~/workspace/sage`; current working directory `agent_home/` is the subdirectory `~/workspace/sage/agent_home`, used for agent context, memory, and workspace files.
## Capabilities
- You are a highly capable coding agent. You can code in any language, and you can use any library or framework.
- You can use web search to get the latest information.
- Use skills in `.codex/skills/` when they match the user's request — read the SKILL.md to understand each skill.
- Use `skill-creator` to create a new skill to meet the user's needs.
- If the task is a simple question, answer directly without unnecessary tool calls.
## Folder Structure
```
├── AGENTS.md              # This file; workspace rules and conventions
├── .codex/                # Codex configuration
│   └── skills/            # Skills (symlinked from .claude/skills/)
├── memory/                # Session-loaded context
│   ├── SOUL.md            # Your identity, principles, capabilities (always loaded)
│   ├── USER.md            # User preferences, context, history (always loaded)
│   ├── MEMORY.md          # Memory index — on-demand file references (always loaded)
│   └── journals/          # Daily/weekly journals, archive/ for old dailies
├── wikis/                 # Knowledge base (Obsidian-style)
└── workspace/             # Workspace root. All your work and outputs should be stored here.
    ├── projects/          # Git repos and code projects
    ├── uploads/           # Uploaded files
    └── outputs/           # Generated outputs
```
> Create if not exists. Create subdirectories as needed.
### Conventions
- **memory/**: All UPPERCASE `.md` files here must be in English. Keep each under 1000 tokens; move detail to separate files under `memory/` if needed.
## Session End Protocol
Before the session ends, **update `memory/USER.md`** and `memory/SOUL.md` if necessary:
- Memories and lessons learned are up-to-date with the latest context.
- Important details are not forgotten across sessions.
- Outdated or irrelevant information is cleaned up.
## Writing Style for `memory/` Files
Dense, telegraphic short sentences. No filler words. Comma/semicolon-joined facts, not bullet lists. `**Bold**` paragraph titles instead of `##` headers. Prioritize information density and low token count.
## Memory
All memory reads/writes go to `./memory/` (relative to this file).
## Notes
- All UPPERCASE `.md` files under `memory/` must be written in English, except for user-language-specific proper nouns or terms that lose meaning in translation.
- `SOUL.md`, `USER.md`, `MEMORY.md` are loaded into context every session. **Keep each file under 1000 tokens.**
