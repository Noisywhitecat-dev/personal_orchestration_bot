# Architecture

Single repository, single `package.json`, directories split by concern. No monorepo.

## Layers

```
src/
  domain/          Pure types + state machine. No I/O, no framework imports.
  application/     Orchestrator + services. Depends on domain and on adapter/repository interfaces only.
  infrastructure/  Concrete adapters (agents), persistence (SQLite), process runner.
  server/          Node HTTP server, routes, SSE event stream. Validates input with Zod.
  web/             React + Vite UI. Talks to server via /api and SSE.
  shared/          Contracts shared between server and web (API shapes).
docs/              Product, architecture, protocol, roadmap, status, next Codex task.
tests/             Integration tests and fixtures (JSONL samples for real adapters later).
```

Dependency direction: `web → shared ← server → application → domain ← infrastructure`. Domain never imports outward.

## Key decisions

| Decision         | Choice                                                                  | Why                                                           |
| ---------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------- |
| Workflow control | Deterministic state machine in `src/domain/state-machine.ts`            | Transitions must be auditable and testable, not prompt-driven |
| Agent boundary   | `AgentAdapter` interface (`src/infrastructure/agents/agent-adapter.ts`) | Claude/Codex CLI formats never leak into domain/application   |
| Agent events     | Normalized union (`src/domain/agent-events.ts`)                         | Adapters translate provider JSON into one vocabulary          |
| Time / IDs       | Injected `Clock` and `IdGenerator`                                      | Deterministic tests                                           |
| Persistence      | SQLite via `node:sqlite` (Node >= 22.5), version-based migrations       | No ORM, no migration framework, no native build step          |
| Realtime         | SSE                                                                     | Simplest one-way stream; WebSocket not needed                 |
| Validation       | Zod at server boundary                                                  | Lightweight runtime schema                                    |
| Errors           | `OrchestrationError` with `code` + user message                         | Do not collapse errors into one string                        |
| Usage            | Raw `UsageRecord` rows + computed aggregates                            | Keep original events; never fake unknowns as 0                |

## Process safety policy

Implemented by `src/infrastructure/process/process-runner.ts` and used by every CLI adapter and by the git review-context collector. Validation scope as of M10: Claude `plan` start has been exercised against the real CLI; Claude review/resume and all Codex paths are stub-tested only (see `docs/STATUS.md`).

- `spawn(file, args, { shell: false })`; never concatenate command strings.
- Working directory resolved to canonical path and verified to be inside the registered project root.
- Explicit env allowlist; secrets never logged.
- stdout / stderr captured separately, bounded in size.
- Timeout + cancellation via `AbortSignal`; child processes killed on shutdown.
- Codex approvals/sandbox never bypassed. `--dangerously-bypass-approvals-and-sandbox` is forbidden.
- Delete, commit, push, external network, and out-of-project writes are treated as separately approved actions.

## Review loop

`Task.reviewRound` counts completed review cycles. `maxReviewRounds` (default 2) is a task-level setting. When a review requests changes and `reviewRound >= maxReviewRounds`, the orchestrator transitions to `failed` with code `REVIEW_ROUNDS_EXCEEDED` and emits a system message for the user.

## Deviations from the suggested layout

- `src/domain/agent-events.ts` added (agent event union belongs to domain, not infrastructure).
- `src/domain/errors.ts` and `src/domain/ports.ts` (Clock, IdGenerator) added.
- `src/server/main.ts` is the entry point; `app.ts` builds the server without listening (testable).
