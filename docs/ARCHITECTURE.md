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
| Execution budget | One application-level guard immediately before every provider run       | Prevent a race or alternate path from bypassing task limits   |
| Public privacy   | DTO mappers remove session ids; runtime status reports classifications  | UI/SSE/REST never expose private runtime/session values       |

## Process safety policy

Implemented by `src/infrastructure/process/process-runner.ts` and used by every CLI adapter and by the git review-context collector. Live validation covers individual Claude start/resume, Codex start/resume, cancellation, timeout, bounded review context, a non-temporary out-of-root denial, and an uninterrupted three-call plan/implement/review completion. An initial run exposed persisted command stdout containing a diff; migration v3 and the application/public boundaries now remove command content. A fresh post-fix run completed with three child exit codes of 0 and clean logical/physical DB scans (see `docs/STATUS.md`).

- `spawn(file, args, { shell: false })`; never concatenate command strings.
- Working directory resolved to canonical path and verified to be inside the registered project root.
- Explicit env allowlist; secrets never logged.
- stdout / stderr captured separately, bounded in size.
- Adapter parsers may use bounded command tails in memory, but the orchestrator persists only
  `commandId`, `exitCode`, and stdout/stderr presence booleans. Public DTOs repeat this redaction for
  legacy/in-memory events.
- Timeout + cancellation via `AbortSignal`; child processes killed on shutdown.
- Codex approvals/sandbox never bypassed. `--dangerously-bypass-approvals-and-sandbox` is forbidden.
- Every Codex prompt repeats the registered-root-only boundary. The sandbox is still the enforcement layer; prompt text is defense in depth.
- Delete, commit, push, external network, and out-of-project writes are treated as separately approved actions.

Windows absolute `codex.exe` selections fail fast unless the executable and all three Desktop helper binaries share one runtime directory. PATH-based commands and test wrappers retain normal lookup behavior; the application does not search private hashed runtime folders.

## Clarification and execution budgets

`draft` planning may produce `awaiting_clarification`. Each answer is persisted, atomically returns the task to `draft`, and starts exactly one resume against the stored Claude session. A second answer in the same state is rejected. A restart never spends tokens automatically: a persisted in-flight `draft` run is closed and the task fails `INTERRUPTED`.

Every task stores maximum Claude/Codex runs, nullable token ceilings, clarification rounds, and review rounds. `executeRun` invokes one centralized guard before inserting the run or entering an adapter. Run counts include failed and cancelled provider entries. Known token totals are checked at the next boundary. Estimated or unavailable records prevent the UI from presenting a reliable remaining-token number; nullable ceilings are unlimited.

SQLite migration v2 adds these fields with compatible defaults and preserves v1 rows. Migration v3 removes legacy command stdout/stderr tails, enables secure deletion, and performs a one-time checkpoint/VACUUM so removed bytes do not remain in free pages or WAL. Public task/run DTOs expose `hasClaudeSession`, `hasCodexSession`, and `hasSession` booleans instead of identifier values.

## Review loop

`Task.reviewRound` counts completed review cycles. `maxReviewRounds` (default 2) is a task-level setting. When a review requests changes and `reviewRound >= maxReviewRounds`, the orchestrator transitions to `failed` with code `REVIEW_ROUNDS_EXCEEDED` and emits a system message for the user.

M14 validated a restart-style continuation without mutating the failed M13 database: a separate SQLite task replayed the already-observed plan and implementation with `unavailable` usage, then the normal Orchestrator path collected the live two-file context and called `ClaudeCliAdapter.resume` with the exact M13 plan session. The resulting approval followed `reviewing → approved → completed`; prompt and diff content were not persisted.

## Deviations from the suggested layout

- `src/domain/agent-events.ts` added (agent event union belongs to domain, not infrastructure).
- `src/domain/errors.ts` and `src/domain/ports.ts` (Clock, IdGenerator) added.
- `src/server/main.ts` is the entry point; `app.ts` builds the server without listening (testable).
