# Core Runtime

`SageCore` owns Sage's assistant conversation runtime. It should remain transport-neutral and provider-agnostic beyond the `AgentProvider` interface.

## Scope

Owned by Core:

- Per-conversation message queueing.
- Agent session creation, restore, and resume ID persistence.
- Active run cancellation and shutdown/restart drain policy.
- Slash commands that affect runtime state.
- Proactive agent execution for scheduler-triggered owner messages.

Owned by `AgentTurnRunner`:

- One assistant turn's provider stream loop.
- Active run registration and cleanup for that turn.
- Provider stream idle timeout supervision.
- Response update/complete lifecycle and final event/session/resume persistence callbacks.

Owned by `ConversationRouter`:

- Conversation lookup and creation.
- Runtime message/thread routing caches.
- Binding incoming and response message/thread IDs back to stable conversations.

Not owned by Core:

- Feishu card JSON, PATCH behavior, image/file upload, or rich media parsing.
- Provider SDK-specific event formats.
- Product-domain app behavior.
- HTTP route parsing.

## Key Types

- `MessageContext`: normalized inbound message from the gateway.
- `MessageGateway`: transport-neutral gateway contract.
- `AssistantResponder`: semantic response lifecycle: `start`, `update`, `complete`, `fail`, `close`.
- `AgentTurnRunner`: transport-neutral assistant turn execution loop.
- `ConversationRouter`: transport-neutral conversation identity lookup and binding.
- `AgentProvider`: model/tool backend contract.
- `HistoryStore`: SQLite persistence for sessions, events, processed Feishu events, and proactive roots.

## Conversation Identity

Internal conversation IDs are immutable `conv_*` values. `ConversationRouter` maps external `first_message_id`, `thread_id`, root message IDs, and response bindings to those internal IDs. Provider session IDs and SDK resume IDs are separate fields.

This avoids tying Sage's internal state to a Feishu message/thread ID or to a specific provider backend.

## Provider Run Supervision

`AgentTurnRunner` wraps each provider stream `next()` call through `src/services/agent-run-supervisor.ts`. The first version enforces an idle timeout between provider events, aborts the current run on timeout, records a clear failed result, and then releases `activeRuns`. The timeout is configured by `SAGE_AGENT_IDLE_TIMEOUT_MS`; the conservative default is 5 minutes.

## Runtime Slash Commands

`/restart` remains available from Feishu, but prod restart is owner-gated. When `OWNER_OPEN_ID` is configured, only that Feishu `open_id` may trigger restart. If it is missing, prod restart is disabled; `sage-dev` may still restart from a p2p dev chat for local iteration. No confirmation command is required.

## Current Gaps

- Provider run supervision is intentionally first-pass only; it does not yet provide circuit breaking, cooldowns, or structured provider error classification.
- Some provider fallback metadata still uses loose event metadata.
- Core remains large and should eventually split proactive execution from the main message runtime.
