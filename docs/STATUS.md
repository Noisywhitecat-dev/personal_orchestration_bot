# STATUS

Last updated: 2026-09-15 (session 3 — asynchronous planning, Claude Code)

## Completed milestones

| Milestone                       | Status                                                                |
| ------------------------------- | --------------------------------------------------------------------- |
| M0 Repo contract                | Done                                                                  |
| M1 Domain + state machine       | Done                                                                  |
| M2 Fake adapters + orchestrator | Done                                                                  |
| M3 SQLite + HTTP API + SSE      | Done                                                                  |
| M4 Minimal React UI             | Done (flow verified in browser)                                       |
| M5 `docs/CODEX_NEXT_TASK.md`    | Done                                                                  |
| M6 Real Codex CLI adapter       | Done (stub-tested; not yet run against the real CLI)                  |
| M7 Asynchronous planning        | Done (POST /api/requests returns 202 + draft; planning in background) |
| M8 Real Claude Code CLI adapter | Done (stub-tested; no live run)                                       |

## Current state

Complete vertical slice runs end-to-end against **fake adapters**: register project → request → plan → approve → fake implement → fake review (optional revision round, same Codex session) → completed / failed. State, runs, messages, timeline and usage persist in SQLite and survive browser refresh and server restart.

A real **Codex CLI adapter** now exists (`CodexCliAdapter`) behind `CODEX_ADAPTER=cli`. The default remains `fake`; Claude is still the fake adapter. The real adapter has been verified only against a Node stub that replays JSONL fixtures — **no real Codex run has been executed yet**.

## Verification log

| Command                                    | Result                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm test`                                 | 13 files, 142 tests passed (96 → 142: +19 Claude parser, +6 Claude argv/forbidden, +21 Claude adapter integration)                                                                                                                                                                                                            |
| `npm run typecheck`                        | clean (strict, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`)                                                                                                                                                                                                                                                      |
| `npm run lint`                             | clean                                                                                                                                                                                                                                                                                                                         |
| `npx prettier --check .`                   | clean                                                                                                                                                                                                                                                                                                                         |
| `npm run build`                            | server → `dist/server`, web → `dist/web`                                                                                                                                                                                                                                                                                      |
| Startup check (`node dist/server/main.js`) | `CODEX_ADAPTER` unset → `codex=fake`; `=cli` → `codex=cli (<exe>, sandbox=workspace-write, timeout=900000ms)`; `=bogus` → process exits with `Invalid CODEX_ADAPTER`                                                                                                                                                          |
| Manual (browser, `npm start`)              | Registered this repo, submitted `... [fake-changes:1]`, approved; observed implement → review(changes) → revise → review(approve) → completed; round 2/2; Claude usage tagged _estimated_, Codex _actual_; reload and server restart restored state (`/api/projects/:id` showed `completed round=2`, claude=920, codex=2050). |

## Important design decisions

- **State machine** (`src/domain/state-machine.ts`): `TRANSITIONS` table + `assertTransition`. `awaiting_approval → queued` additionally requires `userApproved: true` (`APPROVAL_REQUIRED` otherwise). `resolveReviewVerdict` enforces `maxReviewRounds` → `failed` with `REVIEW_ROUNDS_EXCEEDED`.
- **Orchestrator** never writes `task.state` directly; only via `transition()`. Pipeline runs in the background after `approve()`; tests use `whenSettled(taskId)`.
- **Recovery on startup** (`recoverInterrupted`): `queued` tasks restart; `draft` / `implementing` / `reviewing` tasks and their running runs are marked `failed` with `INTERRUPTED`. `draft` is **not** re-planned automatically (would spend tokens unasked). `awaiting_approval` is left as-is. Tasks with a live in-process pipeline are skipped.
- **Usage**: raw `usage_records` rows; aggregates computed on read (`summarizeUsage`) with `hasEstimated` / `hasUnavailable` flags. Unknown = `null`.
- **Timeline bounding**: `message_delta` coalesced into one `agent_message` entry per run (≤ 8 KB); `reasoning_delta` not persisted; command tails ≤ 2 KB.
- **Persistence**: `node:sqlite` (`DatabaseSync`) — no native build, sync API, WAL. Version-based migrations via `PRAGMA user_version`. Repositories are synchronous by design.
- **Vite 6 / Vitest 3** instead of Vite 5 / Vitest 2: Vite 5's builtin list does not know `node:sqlite`, so tests failed to resolve it. Upgrading was cleaner than a resolver workaround.
- **Fake adapters** are deterministic. FakeClaude: plan usage `actual`, review usage `estimated`; `[fake-changes:N]` in the request forces N change-request rounds. FakeCodex: `[fake-fail]` forces `run_failed`.
- **Project root** validation (absolute + `realpath` + must exist) happens in `src/server/routes/api.ts`, keeping `application/` free of `fs`.

## Asynchronous planning (session 3)

- `Orchestrator.submitRequest` persists the `draft` task, the user message and a `request_received` timeline entry, registers the planning pipeline **synchronously** and returns the draft. `whenSettled(taskId)` right after it waits for planning.
- `startPipeline(taskId, body)` is the single registry for planning and implementation pipelines: one active pipeline per task, an `AbortController` per pipeline, cleanup removes only its own entry, unexpected errors → task `failed` + `system_error`, abort-driven early return → no error.
- `runPlanning`: draft → Claude plan run → (`awaiting_approval` + plan + session + Claude message) | `failed` (planner error preserved, else `AGENT_RESULT_INVALID`). If the task left `draft` meanwhile (cancel/reject) the result is discarded.
- `cancel` aborts the planner, waits for the pipeline, then moves to `cancelled`. `reject` moves to `cancelled` first, then aborts. Neither produces `system_error`; a planner that ignores the abort and completes late is still ignored (tested).
- `recoverInterrupted`: `draft` tasks and their running plan runs are failed with `INTERRUPTED` (no automatic re-plan). Tasks with a live pipeline are skipped, so calling it twice is harmless.
- HTTP: `POST /api/requests` → **202** `{ task: <draft> }`. Approve while `draft` → 409.
- UI: submit selects the returned draft and shows "Claude is preparing a plan…"; Approve/Reject only in `awaiting_approval`; Cancel available in `draft`. `isStale`/`mergeTask` compare `updatedAt` so a late HTTP draft response cannot roll back an SSE `awaiting_approval` already applied.
- Tests use `tests/helpers/gated-adapter.ts` (test-only) to park the planner at a gate — no timers.
- Not verified: behaviour with a real, slow planner (no real Claude adapter yet); the Codex live run from session 2 is still outstanding.

## Codex CLI adapter (session 2)

### CLI facts verified on this machine (read-only: `--version`, `exec --help`, `exec resume --help`)

- Version: **codex-cli 0.154.0-alpha.6.2**, binary at `C:\Users\Study\.codex\.sandbox-bin\codex.exe` (Codex desktop install; **not on PATH** → set `CODEX_EXECUTABLE` when using `cli`).
- `codex exec` supports `--json`, `-s/--sandbox <read-only|workspace-write|danger-full-access>`, `-C/--cd`, `--skip-git-repo-check`, `--approve-for-me`, `-c key=value`, prompt via `-` (stdin).
- `codex exec resume` supports `--json`, `-c key=value`, `--skip-git-repo-check`, prompt via `-`. It does **not** list `--sandbox` or `-C`.
- **User config `~/.codex/config.toml` sets `sandbox_mode = "danger-full-access"`.** Without an explicit override a resumed session would inherit that. The adapter therefore pins the sandbox on both paths (see argv).

### Final argv (after the executable)

```
start : exec --json --sandbox workspace-write -C <canonicalProjectRoot> [--skip-git-repo-check] -
resume: exec resume --json -c sandbox_mode="workspace-write" [--skip-git-repo-check] <sessionId> -
```

- Prompt always on stdin. `cwd` of the child = canonical project root (covers the missing `-C` on resume).
- `--skip-git-repo-check` only when `CODEX_SKIP_GIT_REPO_CHECK=1`.
- No approval-policy flags are passed; CLI default applies. If the CLI blocks on approval the run ends by timeout (`TIMEOUT`). `--approve-for-me` was deliberately not used (unverified semantics).
- Forbidden (tested absent, and `assertNoForbiddenArgs` rejects them): `--dangerously-bypass-approvals-and-sandbox`, `--dangerously-bypass-hook-trust`, `--yolo`, `--full-auto`, `--sandbox danger-full-access`, `-a never`, `--ask-for-approval never`, `-c sandbox_mode=danger-full-access`.

### Behaviour

- Session id: `thread.started.thread_id` → `session_started`. On resume the adapter first re-announces the given id; an identical id from the CLI is deduplicated, a different one is passed through (orchestrator stores the last).
- Usage: `turn.completed.usage` → `actual` (missing fields `null`). Exactly one `usage_reported` per run, always **before** the terminal event; `unavailable` if none was reported. No estimation.
- Result: `implementation` with summary = last agent message (≤ 2000 chars), `changedFiles` from `file_change` items else `git status --porcelain` fallback (toggle `gitStatusFallback`), `testsPassed` from the exit code of the last recognised test command (`npm test`, `npx vitest`, `pytest`, …) else `null`.
- Terminal: exactly one; lines after it are ignored. Non-JSON / malformed / unknown lines are counted and skipped. Process exit without a completion → `run_failed` (`TIMEOUT` / `CANCELLED` / `SPAWN_FAILED` / `CODEX_EXITED_WITHOUT_RESULT`) with a ≤ 500-char stderr tail.
- Process runner: `spawn(file, args, {shell:false, windowsHide:true})`, env = `BASE_ENV_KEYS` (PATH/HOME/USERPROFILE/SYSTEMROOT/TEMP/TMP/COMSPEC/PATHEXT) + explicit allowlist, stdout/stderr tails capped at 2 MiB, SIGTERM → SIGKILL after `killGraceMs` (5 s default; Windows additionally `taskkill /pid <pid> /T /F` via argv), children tracked and killed on `exit`/SIGINT/SIGTERM, one summary log line per run (executable, argc, cwd, outcome, exit code, ms).

### Not yet verified / risks

- The JSONL event names (`thread.started`, `item.*`, `turn.completed`, …) follow the documented `codex exec --json` shape but have **not** been confirmed against live output of 0.154.0-alpha.6.2. First real run: capture stdout to a fixture and adjust `codex-jsonl-parser.ts` (mapping table in its header) if names differ.
- `-c sandbox_mode="workspace-write"` on resume is assumed to override the persisted session sandbox; confirm on first real resume.
- Whether `exec resume` honours the child `cwd` as the workspace (no `-C`) is unverified. If not, out-of-root writes would still be blocked by the CLI sandbox, but the workspace could be wrong.
- Approval prompts in non-interactive mode: behaviour unknown; currently surfaces as `TIMEOUT`.
- Windows `taskkill` escalation path is exercised only indirectly (the stub ignores SIGTERM and is killed by `SIGKILL` within the grace period).

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

Added in session 4:

```
src/infrastructure/agents/ claude-jsonl-parser.ts claude-jsonl-parser.test.ts claude-cli-adapter.ts claude-cli-adapter.test.ts
tests/fixtures/claude/ stub-claude.mjs plan-success.jsonl review-approve.jsonl review-changes.jsonl resume.jsonl no-usage.jsonl cli-error.jsonl malformed.jsonl invalid-result.jsonl prose-only.jsonl duplicate-terminal.jsonl model-usage-only.jsonl
tests/integration/claude-cli-adapter.test.ts
src/server/main.ts (CLAUDE_ADAPTER selection)   .env.example   README.md
```

Added in session 2:

```
src/infrastructure/process/ process-runner.ts process-runner.test.ts
src/infrastructure/agents/ codex-jsonl-parser.ts codex-jsonl-parser.test.ts codex-cli-adapter.ts codex-cli-adapter.test.ts
tests/fixtures/codex/ stub-codex.mjs happy-path.jsonl resume.jsonl command-failed.jsonl no-usage.jsonl error.jsonl garbage.jsonl duplicate-completion.jsonl large-output.jsonl
tests/integration/codex-cli-adapter.test.ts
src/server/main.ts (CODEX_ADAPTER selection only)   .env.example
```

## Known issues / temporary implementations

- `data/orchestration.db` was created by the manual browser test and contains one demo project/task; it is git-ignored.
- The `draft` state is visible only briefly with the fake planner; the UI hint ("Claude is preparing a plan…") and the stale-response guard were verified by tests and a manual run, not by observing a slow planner.
- `cancel()` on a running fake task settles the pipeline first; with real adapters, cancellation relies on the adapter honoring `AbortSignal`.
- SSE has no replay / `Last-Event-ID`; a client that reconnects reloads via REST (the UI does this on project select).
- The web `App.tsx` is a single component; no routing, no design system — intentional for MVP.
- `recoverInterrupted` marks interrupted runs failed rather than attempting resume. Resume-on-restart can be added once real session ids exist.
- `.claude/launch.json` runs `npm start` (built output). `npm run dev` runs tsx + Vite with a `/api` proxy; the Vite proxy does not forward SSE by default in all configs — verify when first using `dev` (not exercised this session).

## Next exact work

1. **First live Codex run (user-supervised)**: `CODEX_ADAPTER=cli CODEX_EXECUTABLE=<path> npm start`, register a throwaway git repo, submit a trivial request, approve. Save the raw JSONL (`codex exec --json` stdout) as `tests/fixtures/codex/live-*.jsonl` and fix parser mappings if event names differ. Confirm resume sandbox and cwd behaviour.
2. **Real Claude Code adapter** (`claude -p --output-format stream-json`): same shape as the Codex adapter (process runner + stream parser + argv builders + stub fixtures). Planning now runs in the background, so a slow planner no longer blocks HTTP.
3. Git-diff capture for review input.
