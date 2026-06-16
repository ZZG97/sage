# Architecture Boundaries

Sage should grow by enforcing ownership boundaries, not by adding convenient cross-layer calls.

## Ownership Rules

- Core owns assistant runtime state, not transport formatting.
- Gateway adapters own platform details, not provider behavior.
- Providers own SDK interaction and session semantics, not product domains.
- Apps own product-domain APIs and storage, not global runtime policy.
- Shared infrastructure exists only after at least two owners need the same capability.

## Dependency Rules

Allowed:

```text
WebServer -> apps
apps -> shared
apps -> agent interfaces when the app explicitly runs AI work
SageCore -> AgentProvider
SageCore -> MessageGateway
FeishuService -> MessageGateway implementation
TaskScheduler -> OperationsService
```

Avoid:

```text
SageCore -> Feishu-specific card/render/upload details
Provider -> Feishu or Hono route details
Provider -> app services
App -> another app's repository or service
Route -> direct DB writes for non-trivial behavior
Scheduler workflow -> unbounded shell execution policy hidden in route parsing
```

## Boundary Pattern

For external payloads:

```text
raw payload -> boundary parser/normalizer -> typed domain object -> service/core logic
```

For side effects:

```text
domain decision -> explicit service/capability -> adapter/client call
```

## When To Add Shared Code

Add shared code only when:

- The capability has multiple real consumers.
- The API can be named around domain meaning, not implementation convenience.
- It reduces duplication without hiding side effects.

Do not create shared helpers simply because two files contain similar-looking code.
