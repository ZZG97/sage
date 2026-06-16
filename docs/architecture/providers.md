# Agent Providers

The provider layer adapts multiple AI backends to one Sage runtime contract.

## Provider Contract

`AgentProvider` owns:

- Initialization and health check.
- Session create/restore/delete/cleanup.
- Streaming message execution via `sendMessageStream`.
- Optional structured execution via `runStructured`.
- Resume ID reporting.
- Optional session context updates.

Provider streams emit `AgentEvent` values. Core consumes those events without knowing provider SDK internals. Core supervises stream idleness without changing this interface; if no event arrives before `SAGE_AGENT_IDLE_TIMEOUT_MS`, the current run is aborted and surfaced as a failed turn.

## Current Providers

- `codex`: OpenAI Codex SDK. Supports session context env injection and structured output.
- `claude-code`: Claude Code SDK. Uses Claude Code session semantics.
- `cc-minimax`: Claude Code SDK configured for MiniMax Anthropic-compatible API.
- `opencode`: OpenCode backend.
- `FallbackAgentProvider`: wraps multiple providers, supports active-provider switching and optional auto fallback.

## Session Model

Sage stores local conversation state in SQLite and stores provider session/resume IDs separately. If provider-side session data disappears, Sage may still recover local conversation history, but true provider continuity can be lost.

## Rules

- Provider adapters must not know Feishu or app-domain APIs.
- Provider session ownership should be explicit. Do not silently route an unknown session to the active provider without user-visible warning.
- Fallback should preserve context deliberately and record when continuity changes.
- Non-Codex providers should eventually receive the same `SAGE_*` session context capabilities as Codex.

## Current Gaps

- No circuit breaker or cooldown for repeatedly failing providers.
- Core-level idle timeout exists for stalled streams, but provider-level circuit breaker and richer error classification are still missing.
- Fallback behavior still depends partly on session ID prefixes.
- Structured runner currently depends on provider support and should surface richer failure reasons for batch jobs.
