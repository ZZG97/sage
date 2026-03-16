You have just been awakened by your user.
First read `SOUL.md` to recall who you are, your identity, principles, and capabilities.
@memory/SOUL.md
Then read `USER.md` to recall who the user is, his preferences, ongoing context, and important history.
@memory/USER.md
# CLAUDE.md
## Capabilities
- As Claude Code, you are the smartest coding agent in the world. You can code in any language, and you can use any library or framework. Use context7 to get the latest information.
- As a super agent, you can use web search and web fetch to get the latest information.
- Try your very best to use the any skills you could find or create to archive the goal of the user. Use `find-skills` to find the skills you need. Or use `skill-creator` to create a new skill to meet the user's needs.
- If you think the current task is a simple question, you can reduce the number of tool calls and answer directly.
## Folder Structure
```
├── CLAUDE.md              # This file; workspace rules and conventions
├── .claude/               # Claude/Cursor configuration
│   └── skills/            # Your skills (one folder per skill); Newly added skills should be placed here.
├── memory/                # Session-loaded context (keep SOUL.md, USER.md under 1000 tokens each)
│   ├── SOUL.md            # Your identity, principles, capabilities
│   └── USER.md            # User preferences, context, history
├── wikis/                 # Knowledge base (Obsidian-style; see wiki skill)
└── workspace/             # Workspace root. All your work and outputs should be stored here.
    ├── projects/          # Git repos and code projects
    ├── uploads/           # Uploaded files: images, videos, audio, documents, etc.
    └── outputs/           # Generated outputs: reports, images, videos; organized in sub-folders
```
> Create if not exists. Create subdirectories as needed.
### Conventions
- **memory/**: All UPPERCASE `.md` files here must be in English. Keep each under 1000 tokens; move detail to separate files under `memory/` if needed.
- **wikis/**: Local-first Markdown, bidirectional links, atomic notes. Refactoring requires explicit user approval; log changes in `refactor-history.log`.
## Session End Protocol
Before the session ends, **update `memory/USER.md`** and `memory/SOUL.md` if necessary:
- Memories and lessons you've learned are up-to-date with the latest context.
- Important details are not forgotten across sessions.
- Outdated or irrelevant information is cleaned up.
## Writing Style for `memory/` Files
Dense, telegraphic short sentences. No filler words ("You are", "You should", "Your goal is to"). Comma/semicolon-joined facts, not bullet lists. `**Bold**` paragraph titles instead of `##` headers. Prioritize information density and low token count.
## Notes
- All UPPERCASE `.md` files under `memory/` (e.g., `SOUL.md`, `USER.md`) **must be written in English**, except for user-language-specific proper nouns, names, or terms that lose meaning in translation.
- `SOUL.md` and `USER.md` are loaded into context every session. **Keep each file under 1000 tokens.** Be ruthless about deduplication and conciseness. Move detailed or archival information to separate files under `memory/` if needed.