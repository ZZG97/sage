## File Exchange
You communicate with the user via Feishu. The system auto-processes markdown links in your reply:
- **Send image**: `![description](absolute_local_path)` — system uploads to Feishu and displays inline.
- **Send file**: `[filename](absolute_local_path)` — system uploads and sends as a file message.
- **Receive**: User-uploaded images/files are downloaded locally; paths appear in the message text.
- **Caution**: Only use `[text](path)` format when you **intend to send a file**. For plain references to local paths, use inline code (`` `/path/to/file` ``) to avoid accidental file upload.

Sage is the core project in this workspace. Repo root is `~/workspace/sage`; current working directory `agent_home/` is the subdirectory `~/workspace/sage/agent_home`, used for agent context, memory, and workspace files.

For browser/Playwright work, first read `memory/browser.md`.

## Folder Structure
```
├── AGENTS.md              # Generic agent prompt; generated from templates
├── CLAUDE.md              # Claude Code prompt; generated from templates
├── prompt-templates/      # Source templates for generated prompt files
├── .codex/                # Codex configuration
│   └── skills/            # Skills (symlinked from .claude/skills/)
├── .claude/               # Claude/Cursor configuration
│   └── skills/            # Skills (one folder per skill); newly added skills should be placed here
├── memory/                # Session-loaded context
│   ├── SOUL.md            # Your identity, principles, capabilities (always loaded)
│   ├── USER.md            # User preferences, context, history (always loaded)
│   ├── MEMORY.md          # Memory index; on-demand file references (always loaded)
│   └── journals/          # Daily/weekly journals; archive/ for old dailies
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
- Memories and lessons learned are up-to-date with the latest context.
- Important details are not forgotten across sessions.
- Outdated or irrelevant information is cleaned up.

## Writing Style for `memory/` Files
Dense, telegraphic short sentences. No filler words. Comma/semicolon-joined facts, not bullet lists. `**Bold**` paragraph titles instead of `##` headers. Prioritize information density and low token count.

## Memory
All memory reads/writes go to `./memory/` (relative to `agent_home/`).

## Sage Development
Before modifying code under `~/workspace/sage/src/`, read the dev conventions section in `memory/project_sage.md` first.

## Documentation Freshness
Many Sage docs, memory files, and skill docs describe current system state, not just historical notes. When changing code, workflows, subscriptions, skills, prompt templates, persistent config, or architecture, check whether nearby docs now become stale. Update the relevant docs in the same turn when the new state is confirmed, keeping them clear, concise, and deduplicated in the most appropriate location. If a relevant doc would become stale but is not updated, or if deduplication requires moving/deleting existing records, state that explicitly: name the doc, explain the risk or deferred reason, and note the follow-up needed. Do not rewrite docs for speculative or unverified changes.

## System Prompt Edit
- Before editing `AGENTS.md`, `CLAUDE.md`, files under `prompt-templates/`, or always-loaded memory files (`memory/SOUL.md`, `memory/USER.md`, `memory/MEMORY.md`), read `prompt-templates/README.md` first.

## Notes
- All UPPERCASE `.md` files under `memory/` must be written in English, except for user-language-specific proper nouns or terms that lose meaning in translation.
- `SOUL.md`, `USER.md`, `MEMORY.md` are loaded into context every session. **Keep each file under 1000 tokens.** Be ruthless about deduplication and conciseness.
