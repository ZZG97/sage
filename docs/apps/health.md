# Health App

The Health app stores Laozhang's local personal health records, medications, and lab metrics. It is a private local app; health data must not be exposed, uploaded, or summarized as medical diagnosis.

## Scope

This document owns durable app boundaries for `src/apps/health/`:

- Local SQLite health record storage.
- Health APIs mounted under `/apps/health`.
- Privacy and medical-advice boundaries.

Agent operation procedures live in the `health-manager` skill.

## Current Model

Code paths:

- `src/apps/health/service.ts`: `HealthService` domain operations.
- `src/shared/db-migrations.ts`: `health` SQLite schema and migrations.
- `src/apps/health/routes.ts`: HTTP routes mounted under `/apps/health`.
- `data/health.db`: local SQLite database.
- `agent_home/.claude/skills/health-manager/SKILL.md`: agent workflow for extracting and recording medical documents.

Core entities:

- `medical_records`: visit records, diagnosis JSON, medications JSON, examinations JSON, attachment paths, AI raw analysis, and summary.
- `health_metrics`: structured lab or examination metrics tied to medical records.
- `medication_history`: medication timeline and active medication state.

## Rules

- Health data is sensitive private data. Keep it local unless Laozhang explicitly asks for a specific export.
- Uploaded medical images should be referenced by local attachment paths; do not expose `agent_home/workspace/uploads/`.
- The agent must ask for confirmation before storing OCR or image-derived medical facts when the input is ambiguous.
- The app and skill can organize records and reminders, but must not replace clinician diagnosis or give medical treatment instructions.
- Health HTTP surfaces that read or mutate private state are protected by the shared Sage HTTP auth middleware. Keep `/apps/health/*` and related uploads behind that boundary before any wider exposure.

## Open Gaps

- The skill still operates directly on SQLite for some workflows instead of going through a narrow app wrapper.
- No dedicated repo doc exists yet for future health timeline, reminders, reports, or dashboard design.
