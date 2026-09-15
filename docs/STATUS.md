# STATUS

Last updated: 2026-09-15 (bootstrap session, Claude Code)

## Completed milestones

| Milestone                       | Status                          |
| ------------------------------- | ------------------------------- |
| M0 Repo contract                | Done                            |
| M1 Domain + state machine       | Done                            |
| M2 Fake adapters + orchestrator | Done                            |
| M3 SQLite + HTTP API + SSE      | Done                            |
| M4 Minimal React UI             | Done (flow verified in browser) |
| M5 `docs/CODEX_NEXT_TASK.md`    | Done                            |

## Current state

Complete vertical slice runs end-to-end against **fake adapters**: register project → request → plan → approve → fake implement → fake review (optional revision round, same Codex session) → completed / failed. State, runs, messages, timeline and usage persist in SQLite and survive browser refresh and server restart.

Real Claude / Codex CLIs are **not** invoked anywhere.

## Verification log

| Command                       | Result                                                                                                                                                                                                                                                                                                                        |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm test`                    | 5 files, 36 tests passed (domain unit, orchestrator, persistence, HTTP+SSE)                                                                                                                                                                                                                                                   |
| `npm run typecheck`           | clean (strict, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`)                                                                                                                                                                                                                                                      |
| `npm run lint`                | clean                                                                                                                                                                                                                                                                                                                         |
| `npx prettier --check .`      | clean                                                                                                                                                                                                                                                                                                                         |
| `npm run build`               | server → `dist/server`, web → `dist/web`                                                                                                                                                                                                                                                                                      |
| Manual (browser, `npm start`) | Registered this repo, submitted `... [fake-changes:1]`, approved; observed implement → review(changes) → revise → review(approve) → completed; round 2/2; Claude usage tagged _estimated_, Codex _actual_; reload and server restart restored state (`/api/projects/:id` showed `completed round=2`, claude=920, codex=2050). |

## Important design decisions

- **State machine** (`src/domain/state-machine.ts`): `TRANSITIONS` table + `assertTransition`. `awaiting_approval → queued` additionally requires `userApproved: true` (`APPROVAL_REQUIRED` otherwise). `resolveReviewVerdict` enforces `maxReviewRounds` → `failed` with `REVIEW_ROUNDS_EXCEEDED`.
- **Orchestrator** never writes `task.state` directly; only via `transition()`. Pipeline runs in the background after `approve()`; tests use `whenSettled(taskId)`.
- **Recovery on startup** (`recoverInterrupted`): `queued` tasks restart; `implementing`/`reviewing` tasks and their running runs are marked `failed` with `INTERRUPTED`. `awaiting_approval` is left as-is.
- **Usage**: raw `usage_records` rows; aggregates computed on read (`summarizeUsage`) with `hasEstimated` / `hasUnavailable` flags. Unknown = `null`.
- **Timeline bounding**: `message_delta` coalesced into one `agent_message` entry per run (≤ 8 KB); `reasoning_delta` not persisted; command tails ≤ 2 KB.
- **Persistence**: `node:sqlite` (`DatabaseSync`) — no native build, sync API, WAL. Version-based migrations via `PRAGMA user_version`. Repositories are synchronous by design.
- **Vite 6 / Vitest 3** instead of Vite 5 / Vitest 2: Vite 5's builtin list does not know `node:sqlite`, so tests failed to resolve it. Upgrading was cleaner than a resolver workaround.
- **Fake adapters** are deterministic. FakeClaude: plan usage `actual`, review usage `estimated`; `[fake-changes:N]` in the request forces N change-request rounds. FakeCodex: `[fake-fail]` forces `run_failed`.
- **Project root** validation (absolute + `realpath` + must exist) happens in `src/server/routes/api.ts`, keeping `application/` free of `fs`.

## Files created

```
.editorconfig .gitignore .prettierrc .prettierignore .env.example
package.json tsconfig.json tsconfig.build.json vite.config.ts vitest.config.ts eslint.config.js
README.md AGENTS.md CLAUDE.md
.claude/launch.json                      (preview config for the built server)
docs/PRODUCT.md ARCHITECTURE.md PROTOCOL.md ROADMAP.md STATUS.md CODEX_NEXT_TASK.md
src/domain/ ids.ts ports.ts errors.ts project.ts task.ts run.ts usage.ts message.ts agent-events.ts state-machine.ts
src/domain/ state-machine.test.ts usage.test.ts
src/application/ repositories.ts events.ts orchestrator.ts
src/infrastructure/agents/ agent-adapter.ts fake-claude-adapter.ts fake-codex-adapter.ts
src/infrastructure/persistence/ database.ts sqlite-repositories.ts in-memory-repositories.ts
src/server/ app.ts main.ts routes/api.ts events/sse.ts
src/shared/contracts.ts
src/web/ index.html styles.css main.tsx api.ts pages/App.tsx components/UsageTable.tsx hooks/useEvents.ts
tests/integration/ orchestrator.test.ts persistence.test.ts api.test.ts
```

Not yet created (planned): `src/infrastructure/process/process-runner.ts`, `src/infrastructure/agents/codex-jsonl-parser.ts`, `tests/fixtures/*` — these are the next Codex task.

## Known issues / temporary implementations

- `data/orchestration.db` was created by the manual browser test and contains one demo project/task; it is git-ignored.
- The UI keeps `busy` for the whole `submitRequest` round-trip (plan generation is synchronous in the HTTP handler). Fine for fakes; a real planner may take minutes — consider making `/api/requests` return the `draft` task immediately and planning in the background.
- `cancel()` on a running fake task settles the pipeline first; with real adapters, cancellation relies on the adapter honoring `AbortSignal`.
- SSE has no replay / `Last-Event-ID`; a client that reconnects reloads via REST (the UI does this on project select).
- The web `App.tsx` is a single component; no routing, no design system — intentional for MVP.
- `recoverInterrupted` marks interrupted runs failed rather than attempting resume. Resume-on-restart can be added once real session ids exist.
- `.claude/launch.json` runs `npm start` (built output). `npm run dev` runs tsx + Vite with a `/api` proxy; the Vite proxy does not forward SSE by default in all configs — verify when first using `dev` (not exercised this session).

## Next exact work

1. **Codex**: implement the real Codex CLI adapter per `docs/CODEX_NEXT_TASK.md` (allowed files listed there).
2. **Claude (review)**: verify argv never contains forbidden flags, fixtures cover all listed cases, no domain/application changes.
3. After that: real Claude Code adapter (`claude -p --output-format stream-json`), then git-diff capture for review input.
