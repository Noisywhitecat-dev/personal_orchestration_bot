# STATUS

Last updated: 2026-09-15 (session 6 — live Claude planning validation, Claude Code)

## Completed milestones

| Milestone                            | Status                                                                             |
| ------------------------------------ | ---------------------------------------------------------------------------------- |
| M0 Repo contract                     | Done                                                                               |
| M1 Domain + state machine            | Done                                                                               |
| M2 Fake adapters + orchestrator      | Done                                                                               |
| M3 SQLite + HTTP API + SSE           | Done                                                                               |
| M4 Minimal React UI                  | Done (flow verified in browser)                                                    |
| M5 `docs/CODEX_NEXT_TASK.md`         | Done                                                                               |
| M6 Real Codex CLI adapter            | Done (stub-tested; not yet run against the real CLI)                               |
| M7 Asynchronous planning             | Done (POST /api/requests returns 202 + draft; planning in background)              |
| M8 Real Claude Code CLI adapter      | Done (stub-tested; no live run)                                                    |
| M9 Git diff capture for review input | Done (temp-git-repo + fake-adapter tested; no live run)                            |
| M10 Live Claude planning validation  | Done (2 approved live calls: 1 auth failure + 1 successful plan on claude 2.1.260) |

## Current state

Complete vertical slice runs end-to-end against **fake adapters**: register project → request → plan → approve → fake implement → fake review (optional revision round, same Codex session) → completed / failed. State, runs, messages, timeline and usage persist in SQLite and survive browser refresh and server restart.

Real CLI adapters exist for both roles: `CodexCliAdapter` behind `CODEX_ADAPTER=cli` and `ClaudeCliAdapter` behind `CLAUDE_ADAPTER=cli`. Both default to `fake`. Both have been verified only against Node stubs that replay JSONL fixtures — **no real Codex run and no real Claude model call has been executed yet**.

Review prompts now carry a bounded, read-only git diff of the working tree (session 5); it is memory-only and never persisted.

Session 6 made **two** user-approved live `claude.exe` invocations (2.1.260) on a throwaway repository. The first failed at the API step (the standalone CLI was logged out); after the user ran `claude auth login`, the second **produced a valid structured plan**. Both captures were sanitized into fixtures and the parser handled both without code changes to its invariants. Codex has still never been run live.

## Verification log

| Command                                                 | Result                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm test`                                              | 15 files, 186 tests passed (179 → 186: +3 live auth-error tests, +4 live successful-plan tests)                                                                                                                                                                                                                               |
| `npm run typecheck`                                     | clean (strict, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`)                                                                                                                                                                                                                                                      |
| `npm run lint`                                          | clean                                                                                                                                                                                                                                                                                                                         |
| `npx prettier --check .`                                | clean                                                                                                                                                                                                                                                                                                                         |
| `npm run build`                                         | server → `dist/server`, web → `dist/web`                                                                                                                                                                                                                                                                                      |
| Startup check (review diff, `node dist/server/main.js`) | unset → `review diff: git, max 65536 bytes, memory-only`; `REVIEW_DIFF_MAX_BYTES=4096` → `max 4096`; `0`, `-1`, `abc`, `1.5` → process exits with `Invalid REVIEW_DIFF_MAX_BYTES`                                                                                                                                             |
| Startup check (Claude, `node dist/server/main.js`)      | `CLAUDE_ADAPTER` unset → `claude=fake`; `=cli` → `claude=cli (claude, permission-mode=plan read-only, timeout=600000ms)`; `max-turns=N` is appended only when `CLAUDE_MAX_TURNS` is set (checked with `CLAUDE_MAX_TURNS=8`); `=bogus`, `CLAUDE_MAX_TURNS=0`, `CLAUDE_TIMEOUT_MS=abc` → process exits with `Invalid CLAUDE_*`  |
| Startup check (`node dist/server/main.js`)              | `CODEX_ADAPTER` unset → `codex=fake`; `=cli` → `codex=cli (<exe>, sandbox=workspace-write, timeout=900000ms)`; `=bogus` → process exits with `Invalid CODEX_ADAPTER`                                                                                                                                                          |
| Manual (browser, `npm start`)                           | Registered this repo, submitted `... [fake-changes:1]`, approved; observed implement → review(changes) → revise → review(approve) → completed; round 2/2; Claude usage tagged _estimated_, Codex _actual_; reload and server restart restored state (`/api/projects/:id` showed `completed round=2`, claude=920, codex=2050). |

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

## Live Claude planning validation (session 6, M10)

### What ran

- Exactly **2** live `claude.exe` invocations (each individually user-approved), **0** Codex invocations, no resume, no review. Call 1 failed on authentication; after the user logged the CLI in, call 2 succeeded.
- Executable: version `2.1.260 (Claude Code)`. **Path depends on the caller**: the Claude desktop app is an MSIX package, so inside it the binary resolves as `%APPDATA%\Claude\claude-code\2.1.260\claude.exe`, while an ordinary shell must use the real location `%LOCALAPPDATA%\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\Claude\claude-code\2.1.260\claude.exe`. Set `CLAUDE_EXECUTABLE` accordingly. Auth (`claude auth login`, `claude auth status`) is stored in `~/.claude/.credentials.json`, which is not virtualized, so both paths share one login. `--help` re-checked: `--print`, `--output-format stream-json`, `--verbose`, `--permission-mode plan`, `--permission-prompts none`, `--json-schema`, `--resume`, `--model` present; **`--max-turns` absent** (not passed).
- argv exactly as `buildClaudeStartArgs({ kind: 'plan' })`: `--print --output-format stream-json --verbose --permission-mode plan --permission-prompts none --json-schema <plan schema>`. Prompt (417 bytes, no secrets/project data) on stdin. Env = the production allowlist only. cwd = a throwaway git repo (one README, local git config only) under the temp directory.
- One-off harness (untracked, scratchpad) reused the production argv builder, `runProcess` and `ClaudeJsonlParser`, tee-ing stdout to a git-ignored `data/live-captures/*.raw.jsonl` (deleted after sanitization; `data/live-captures/` added to `.gitignore`).

### Result — call 1 (auth failure)

- Exit 1 after 1.9 s. stdout: 3 JSONL lines (`system/init`, `assistant`, `result`), stderr empty.
- `system/init`: `session_id` is a UUID; `permissionMode: "plan"` echoed; `apiKeySource: "none"`; `model`, `claude_code_version`, `tools[]`, plus machine-specific fields (`cwd`, `memory_paths`, `messaging_socket_path`, `powershell_path`) that must never reach fixtures.
- `assistant`: `message.content: [{type:"text", text}]`, `message.usage` (nested shape), top-level `error: "authentication_failed"`, `is_api_error_message: true`, same `session_id`.
- `result`: **`subtype: "success"` yet `is_error: true`**, `terminal_reason: "api_error"`, `api_error_status: null`, no `errors` array, no `structured_output`, message in `result`, `num_turns: 1`, `permission_denials: []`. `usage` is nested: `input_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`, `output_tokens`, `output_tokens_details.thinking_tokens`, `cache_creation.{ephemeral_1h_input_tokens, ephemeral_5m_input_tokens}`, `server_tool_use`, `service_tier`, `speed`, … (all zero here). `modelUsage: {}`.
- Parser (unchanged code) produced `session_started > message_delta > usage_reported > run_failed(CLAUDE_ERROR)`; unknown = 0, malformed = 0, one terminal, usage before terminal. No default plan was synthesized.
- Throwaway repository unchanged: `git status --porcelain` empty before and after, README SHA-256 identical, HEAD identical.
- Root cause (offline check, no token values read): `~/.claude/.credentials.json` has empty `accessToken`/`refreshToken` and `expiresAt: 0` — the standalone CLI is logged out on this machine. The desktop app that hosts the Claude Code session uses separate auth. Whether the env allowlist would also matter once logged in is still unknown.

### Result — call 2 (successful plan)

- Exit 0 after 17.8 s. stdout: **23** JSONL lines: `system/init` ×1, `system/thinking_tokens` ×7, `rate_limit_event` ×3, `assistant` ×7, `user` (tool results) ×4, `result/success` ×1. stderr empty.
- `result`: `is_error: false`, `terminal_reason: "completed"`, `stop_reason: "tool_use"`, `num_turns: 5`, `permission_denials: []`, and **`structured_output` present** and schema-valid. The same JSON is also duplicated in the `result` string.
- **`--json-schema` works**: the model produced the answer by calling an internal `StructuredOutput` tool; the run contained **no `text` content blocks at all**, and `thinking` blocks carried an empty string plus a `signature`. So a successful schema-driven run can legitimately emit no `message_delta` and no `reasoning_delta` — the parser must not require them (it does not).
- Real usage: `input_tokens: 8`, `cache_creation_input_tokens: 36425`, `cache_read_input_tokens: 105666`, `output_tokens: 1058`, `output_tokens_details.thinking_tokens: 346`. Mapped to `inputTokens 142099 / cachedInputTokens 105666 / outputTokens 1058 / reasoningTokens 346 / totalTokens 143157`, `source: "actual"`.
- Parser output: `session_started > usage_reported > run_completed` with a valid `plan` result, one terminal, usage before it, unknown = 0, malformed = 0.
- **Plan mode held**: the throwaway repository was byte-identical before and after (`git status --porcelain` empty, README SHA-256 and HEAD unchanged) even though the model _did_ issue a `Write` tool call. That write went to Claude Code's own plan scratch file under `~/.claude/plans/`, i.e. outside the project root — **plan mode protects the workspace but the CLI still writes its own plan document into the user's home**. `permission_denials` stayed empty, so a denial is not how this surfaces.
- `modelUsage` listed two models (a sonnet main model plus a small helper model). Top-level `usage` reflects only the main model, so the helper model's tokens are **not** counted in our snapshot (the parser prefers top-level `usage`, by design). This under-counts slightly; documented rather than changed.

### Changes made from the capture

- `tests/fixtures/claude/live-auth-error-v2.1.260.jsonl` (3 lines) and `tests/fixtures/claude/live-plan-v2.1.260.jsonl` (23 lines): field-whitelisted copies. Session ids → `sess-live-0001` / `sess-live-plan-0001`, uuids → fixed test uuids, tool inputs and tool results → `<redacted>`, cwd/paths/timings removed or replaced; field names, nesting, ordering and the usage numbers are real. 7 regression tests cover both.
- `claude-jsonl-parser.ts` (3 small changes, invariants unchanged): `usage.output_tokens_details.thinking_tokens` → `reasoningTokens`; `terminal_reason` appended to the `CLAUDE_ERROR` message; `rate_limit_event` added to the known-ignored line types (it was being counted as unknown).

### Still unverified

- Resume (`--resume`), review runs, and the orchestrator's full implement → review loop against a live Claude.
- Any live Codex run (the Codex adapter remains stub-tested only).
- Whether long runs hit the timeout, and how a real permission denial surfaces (`permission_denials` was empty here).
- Side effect to keep in mind: each live planning run leaves a plan markdown file in `~/.claude/plans/`.

## Review context / git diff capture (session 5)

### Structure

- `src/application/review-context.ts`: `ReviewContextCollector` port, `ReviewContext` (`status: available|empty|unavailable`, `content`, `files`, `omitted[{path, reason}]`, `truncated`, `bytes`, `warning`), `noReviewContextCollector` default.
- `src/application/review-prompt.ts`: pure `buildReviewPrompt` and marker escaping.
- `src/infrastructure/git/git-review-context-collector.ts`: git-backed implementation.
- `Orchestrator` takes an optional `reviewContext` (default: unavailable). `src/server/main.ts` always injects the git collector; tests inject doubles.

### Git commands (all via `runProcess`: argv array, `shell:false`, cwd = canonical root, timeout 30 s, AbortSignal, output capped)

```
git --no-pager -c core.quotePath=false rev-parse --show-toplevel
git --no-pager -c core.quotePath=false status --porcelain=v1 -z --untracked-files=all [-- :(literal)<path> ...]
git --no-pager -c core.quotePath=false diff --no-ext-diff --no-textconv --no-color --relative HEAD -- :(literal)<path> ...
  (unborn HEAD: diff --cached + diff instead)
```

Nothing is staged, stashed, reset or checked out. `--no-ext-diff` / `--no-textconv` keep user-configured external diff tools and textconv filters from running; `--no-pager` avoids a pager. Pathspecs are `:(literal)` so glob characters and leading dashes are literal.

### Path validation of `changedFiles` (scope hint only)

Rejected (listed as omitted with a reason): absolute paths (POSIX and `C:\`), control characters (NUL/CR/LF), `..` traversal, paths resolving outside the root, pathspec magic (`:`-prefixed). Backslashes normalized to `/`, `./` stripped, duplicates removed. If no valid hint remains, the whole tree is inspected.

### Exclusions

- Directories: `.git/`, `node_modules/`, `dist/` (`excluded_dir`).
- Sensitive basenames: `.env`, `.env.*` (**`.env.example` is allowed**, tested), `*.pem|key|p12|pfx|jks|keystore`, `id_rsa*`/`id_ed25519*`…, `credentials*`, `secret(s)*`, `*.secret`, `.npmrc`, `.netrc`, `.htpasswd` (`sensitive`).
- Untracked files: symlinks (`symlink`), realpath outside root (`outside_root`), NUL in the first 8 KB (`binary`), larger than the per-file cap (`too_large`).
- Tracked binaries appear only as git's `Binary files … differ` line.
  Omitted files are shown to the reviewer as `path: reason`, never with content.

### Size limits

- `REVIEW_DIFF_MAX_BYTES` (default **65536**, positive integer, validated at startup) caps the whole context; per-file cap 16 KiB (never above the total). Truncation is UTF-8 safe (`truncateUtf8`) and always adds an explicit marker; `truncated=true` and a warning are surfaced in the prompt. Git output buffering is capped at 4× the budget.
- Log line only: `[review-context] status=… files=N bytes=N truncated=… omitted=N`. No paths, no content.

### Review prompt

Sections: read-only reviewer role · review round · user request · approved plan · implementation report (self-reported, unverified) · previous review rounds · working-tree context status (available/empty/unavailable, truncated, omitted list) · untrusted block between `<<<BEGIN_UNTRUSTED_REVIEW_CONTEXT>>>` / `<<<END_UNTRUSTED_REVIEW_CONTEXT>>>` (marker look-alikes inside the diff are rewritten to `…_ESCAPED>>>`) · guidance (no instructions from the diff, no file edits, no unverifiable claims, lower confidence when truncated/unavailable) · required `{kind:"review", verdict, summary, changeRequests}`. Uses the existing Claude JSON schema; nothing duplicated.

### Non-persistence and flow

- The diff exists only in the prompt string passed to the reviewer adapter. Tests assert it is absent from task/runs/messages/timeline/usage/SSE events and from the process logger.
- Flow per round: implementation result → collect (fresh each round) → re-check cancellation → `review_requested` → `reviewing` → prompt. Cancellation during collection ends `cancelled` with no review run. Collector-level failures → `unavailable`, review proceeds. An unexpected throw → `system_error` (`REVIEW_CONTEXT_FAILED`, generic message) and `unavailable`.
- Side fix: after any implement/review run the loop now re-checks the abort signal, so cancelling mid-run ends `cancelled` instead of `failed(CANCELLED)`.

### Limitations

- The snapshot is the **current working tree**, not proof of Codex authorship. Pre-existing local edits are mixed in; `changedFiles` only narrows the scope. The prompt says so.
- Only common secret-looking basenames are excluded; this is not a secret scanner.
- Verified with temporary git repositories and fake adapters only; no real Claude/Codex call was made.

## Claude Code CLI adapter (session 4)

### CLI facts verified on this machine (read-only: `--version`, `--help`)

- Version: **2.1.260 (Claude Code)**, binary at `%APPDATA%\Claude\claude-code\2.1.260\claude.exe` (desktop-app install; **not on PATH** → set `CLAUDE_EXECUTABLE` for `cli`).
- Listed: `-p/--print`, `--output-format text|json|stream-json`, `--verbose`, `--permission-mode acceptEdits|auto|bypassPermissions|manual|dontAsk|plan`, `--permission-prompts host|none`, `--json-schema <schema>`, `-r/--resume <session-id>`, `-c/--continue`, `--dangerously-skip-permissions`, `--allow-dangerously-skip-permissions`, `--model`, `--include-partial-messages`, `--max-budget-usd`.
- **Not listed: `--max-turns`.** It is therefore passed only when `CLAUDE_MAX_TURNS` is set explicitly; the default leaves it out. Never verified against a model.

### Final argv (after the executable)

```
start : --print --output-format stream-json --verbose --permission-mode plan --permission-prompts none --json-schema <plan|review schema> [--max-turns N] [--model M]
resume: same + --resume <sessionId>
```

- Prompt always on stdin; never in argv or logs. Child `cwd` = canonical project root.
- `--permission-prompts none`: anything that would prompt is denied automatically (non-interactive safety on top of plan mode).
- `--continue` is never used (it would silently pick the most recent session).
- Forbidden (tested absent; `assertNoForbiddenClaudeArgs` rejects them): `--dangerously-skip-permissions`, `--allow-dangerously-skip-permissions`, `--continue`, `-c`, any `--permission-mode` other than `plan`, argv without `--permission-mode`.
- Session ids must match `^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$` (no option-like values).

### Behaviour

- Supported kinds: `plan`, `review`. `implement`/`revise` → `UNSUPPORTED_KIND` with no child process.
- Parser mapping: `system.init` → `session_started`; assistant `text` → `message_delta` (≤ 8 KB per run); assistant `thinking` → `reasoning_delta`; `result.usage` → `usage_reported`; success + valid structured output → `run_completed`; `is_error`/`error_*` → `run_failed` (`CLAUDE_ERROR`). `user`, `stream_event`, unknown types ignored (counted).
- Result: `structured_output` → JSON `result` string → single ```json fence → else `AGENT_RESULT_INVALID`. Validated with zod (`PlanResultSchema`, `ReviewResultSchema`, strict, non-empty strings, non-empty steps, `request_changes` needs ≥ 1 request). The same JSON Schema is passed via `--json-schema`. No prose extraction, no default plan, no auto-approve.
- Usage: `inputTokens = input_tokens + cache_creation_input_tokens + cache_read_input_tokens`; `cachedInputTokens = cache_read_input_tokens` (subset, not re-added); `totalTokens = inputTokens + outputTokens`; `reasoningTokens = null`. Top-level `usage` wins; `modelUsage` is summed only when `usage` is absent (fixture `model-usage-only.jsonl`). Cost fields ignored. Exactly one `usage_reported` per run, before the terminal; `unavailable` when none.
- Resume: the known id is re-announced once; the CLI echoing the same id is suppressed; a different id is passed through so the orchestrator stores the latest.
- Terminal exactly once; later lines ignored. Process end without result → `TIMEOUT` / `CANCELLED` / `SPAWN_FAILED` / `CLAUDE_EXITED_WITHOUT_RESULT` with ≤ 500-char stderr tail. `cancel(runId)` and `input.signal` abort the child; controllers and tracked children are cleaned up (asserted).
- Fixtures: `tests/fixtures/claude/` (`plan-success`, `review-approve`, `review-changes`, `resume`, `no-usage`, `cli-error`, `malformed`, `invalid-result`, `prose-only`, `duplicate-terminal`, `model-usage-only`) and `stub-claude.mjs`. All synthetic.

### Not yet verified / risks

- The stream-json shapes (`system.init`, `assistant.message.content[]`, `result.structured_output`, `result.usage`) follow the documented format but were **not** confirmed against live 2.1.260 output. First real run: capture stdout as `tests/fixtures/claude/live-*.jsonl` and adjust the parser header table if names differ.
- Whether `--json-schema` populates `structured_output` on this version, and whether `--permission-mode plan` + `--permission-prompts none` completes without prompting, is unverified.
- `--max-turns` support is unknown on 2.1.260 (absent from help); a wrong flag would make the CLI exit → surfaces as `CLAUDE_EXITED_WITHOUT_RESULT`.
- Review prompts now include a bounded git diff (session 5, M9); Claude permissions were not widened for it.

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

Added in session 6:

```
tests/fixtures/claude/live-auth-error-v2.1.260.jsonl   (sanitized live capture, call 1)
tests/fixtures/claude/live-plan-v2.1.260.jsonl         (sanitized live capture, call 2)
.gitignore (data/live-captures/)
```

Added in session 5:

```
src/application/ review-context.ts review-prompt.ts
src/infrastructure/git/git-review-context-collector.ts
tests/helpers/recording-adapter.ts
tests/integration/ git-review-context-collector.test.ts review-context.test.ts
src/server/main.ts (collector + REVIEW_DIFF_MAX_BYTES)   .env.example   README.md
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

1. **Minimal live Codex implement/resume test (user-supervised)** on a throwaway git repo: confirm the `exec` argv, the JSONL event names, resume sandbox/cwd behaviour, and usage. Sanitize into `tests/fixtures/codex/live-*.jsonl` and adjust the Codex parser if names differ.
2. **Live Claude review run** (needs a real implementation to review): verify the review schema path and that the bounded diff fits the prompt.
3. Then evaluate an explicitly gated emergency-repair path and/or packaging.
