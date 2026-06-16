# Core Runtime

`SageCore` owns Sage's assistant conversation runtime. It should remain transport-neutral and provider-agnostic beyond the `AgentProvider` interface.

## Scope

Owned by Core:

- Conversation lookup and creation.
- Per-conversation message queueing.
- Agent session creation, restore, and resume ID persistence.
- Active run tracking and cancellation.
- Slash commands that affect runtime state.
- Proactive agent execution for scheduler-triggered owner messages.
- Binding response messages/thread IDs back to conversations.

Not owned by Core:

- Feishu card JSON, PATCH behavior, image/file upload, or rich media parsing.
- Provider SDK-specific event formats.
- Product-domain app behavior.
- HTTP route parsing.

## Key Types

- `MessageContext`: normalized inbound message from the gateway.
- `MessageGateway`: transport-neutral gateway contract.
- `AssistantResponder`: semantic response lifecycle: `start`, `update`, `complete`, `fail`, `close`.
- `AgentProvider`: model/tool backend contract.
- `HistoryStore`: SQLite persistence for sessions, events, processed Feishu events, and proactive roots.

## Conversation Identity

Internal conversation IDs are immutable `conv_*` values. Feishu `first_message_id` and `thread_id` are external lookup fields. Provider session IDs and SDK resume IDs are separate fields.

This avoids tying Sage's internal state to a Feishu message/thread ID or to a specific provider backend.

## Current Gaps

- No unified provider run supervisor for idle timeout, stalled streams, and structured error classification.
- Some provider fallback metadata still uses loose event metadata.
- Core remains large and should eventually be split into conversation routing, run execution, slash commands, and proactive execution.
