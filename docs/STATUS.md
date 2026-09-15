# STATUS

Last updated: 2026-09-16 (session 12 — M14 exact-session review continuation, Codex)

## Completed milestones

| Milestone                               | Status                                                                                                 |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| M0 Repo contract                        | Done                                                                                                   |
| M1 Domain + state machine               | Done                                                                                                   |
| M2 Fake adapters + orchestrator         | Done                                                                                                   |
| M3 SQLite + HTTP API + SSE              | Done                                                                                                   |
| M4 Minimal React UI                     | Done (flow verified in browser)                                                                        |
| M5 `docs/CODEX_NEXT_TASK.md`            | Done                                                                                                   |
| M6 Real Codex CLI adapter               | Done (live start/resume validated in M11)                                                              |
| M7 Asynchronous planning                | Done (POST /api/requests returns 202 + draft; planning in background)                                  |
| M8 Real Claude Code CLI adapter         | Done (live plan start M10, review start M12, exact-session review resume M14)                          |
| M9 Git diff capture for review input    | Done (temp-git-repo + fake-adapter tested; no model involved)                                          |
| M10 Live Claude planning validation     | Done (2 approved live calls: 1 auth failure + 1 successful plan on claude 2.1.260)                     |
| M11 Live Codex start/resume validation  | Done (runtime preflight added; successful start + exact-session resume on codex-cli 0.154.0-alpha.6.2) |
| M12 Live Claude review validation       | Done (one bounded-diff review start returned schema-valid `request_changes` on Claude Code 2.1.260)    |
| M13 Live two-provider orchestrator loop | Partial (real plan and implement ran; review was correctly blocked by a newly observed parser gap)     |
| M14 Exact-session review continuation   | Done (one real Claude resume approved the M13 two-file implementation; continuation task completed)    |

## Current state

Complete vertical slice runs end-to-end against **fake adapters**: register project → request → plan → approve → fake implement → fake review (optional revision round, same Codex session) → completed / failed. State, runs, messages, timeline and usage persist in SQLite and survive browser refresh and server restart.

Real CLI adapters exist for both roles: `CodexCliAdapter` behind `CODEX_ADAPTER=cli` and `ClaudeCliAdapter` behind `CLAUDE_ADAPTER=cli`. Both default to `fake`.

Verification status per path — this table is the authoritative summary; the per-session sections below are historical records of when each fact was established:

| Path                              | Implemented | Stub/fixture tested                  | Live tested                                                        |
| --------------------------------- | ----------- | ------------------------------------ | ------------------------------------------------------------------ |
| Claude `plan` start               | yes         | yes                                  | **yes** (claude 2.1.260, session 6)                                |
| Claude `review`                   | yes         | yes                                  | **yes** (bounded deliberate defect, session 10)                    |
| Claude `--resume`                 | yes         | yes                                  | **yes** (exact M13 plan session, session 12)                       |
| Codex `implement` start           | yes         | yes                                  | **yes** (codex-cli 0.154.0-alpha.6.2, session 9)                   |
| Codex `revise` / resume           | yes         | yes                                  | **yes** (same session id, sandbox override + child cwd, session 9) |
| Git review context (bounded diff) | yes         | yes (temp git repos + fake adapters) | **yes** (embedded in the live M12 review prompt)                   |
| Orchestrator full loop            | yes         | yes (fake adapters)                  | **cumulative** (M13 plan+implement → M14 resumed review+complete)  |

Review prompts carry a bounded, read-only git diff of the working tree (session 5); it is memory-only and never persisted.

Session 6 made **two** user-approved live `claude.exe` planning invocations (2.1.260) on a throwaway repository. M11 used two separately approved attempts: session 8 recorded one failed Codex start caused by an incomplete Desktop runtime path; session 9 selected the complete runtime and successfully ran one new start plus one exact-session resume. Session 10 (M12) made one approved Claude review start over a bounded deliberate defect and received `request_changes`. Session 11 (M13) connected the real Orchestrator, SQLite, Claude plan start and Codex implement start. Codex created only the requested files and its tests passed, but its Windows `pwsh.exe -Command 'npm test'` event was not recognised as a test command, so the guard stopped before review. Session 12 (M14) replayed those two historical results without model calls and used the exact stored plan session for one real Claude review resume. The review approved and the separate continuation task completed. This proves the stages cumulatively, not in one uninterrupted three-call execution.

## Verification log

| Command                                                 | Result                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm test`                                              | 15 files, 202 tests passed (200 → 202 in M13: Windows PowerShell-wrapped Codex test-command parser and adapter regressions)                                                                                                                                                                                                   |
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

### Still unverified at the end of M10

- Resume (`--resume`), review runs, and the orchestrator's full implement → review loop against a live Claude.
- A successful live Codex implementation and any live Codex resume run. M11 later completed both.
- Whether long runs hit the timeout, and how a real permission denial surfaces (`permission_denials` was empty here).
- Side effect to keep in mind: each live planning run leaves a plan markdown file in `~/.claude/plans/`.

## Live Codex validation (sessions 8–9, M11 — done)

### Root cause and fail-fast runtime validation

- Session 8 selected `C:\Users\Study\.codex\.sandbox-bin\codex.exe`. Its SHA-256 matched the Desktop runtime's CLI, but that directory lacked `codex-code-mode-host.exe`, `codex-command-runner.exe` and `codex-windows-sandbox-setup.exe`. The CLI therefore reached the model but all file operations failed closed. The parser correctly preserves its real usage and emits `run_failed(CODEX_ITEM_ERROR)` despite process exit 0 and `turn.completed`.
- `CodexCliAdapter` now validates a Windows absolute `codex.exe` at construction time. The executable and all three sibling helpers must exist or configuration fails with `VALIDATION_FAILED` naming the selected executable and missing components, before `runProcess` or a model call. PATH-based `codex` and wrapper/stub executables are unaffected. No user path or private runtime hash is hardcoded, and the application does not auto-discover Desktop hash directories.
- Live preflight explicitly selected `C:\Users\Study\AppData\Local\OpenAI\Codex\bin\12219cbfbcbddde7\codex.exe` through the harness's `CODEX_EXECUTABLE` equivalent. Version was `codex-cli 0.154.0-alpha.6.2`; the executable and all three helpers existed. The two CLI copies had identical SHA-256 `960C111D47AFD61669954B9DF9E56083E302EDBFA3EF6962D81DCC14A30051DC`.

### Successful start and resume

- After the runtime fix, the user approved exactly one new start and, only after success, one resume. Session 9 ran **one start and one resume**, with **zero retries** and **zero Claude calls**. Across M11's two separately approved attempts, there were two starts (one failed in session 8, one successful in session 9) and one successful resume.
- Throwaway repository: `C:\Users\Study\AppData\Local\Temp\orchestration-m11-runtime-20260915-2245\repo`; sentinel: its parent `SENTINEL.txt`. The product repository was never passed as `-C`, `cwd` or prompt content. The one-off harness reused production argv builders, runtime preflight, `runProcess` (`shell:false`, timeout, `AbortSignal`) and `CodexJsonlParser`, and was dry-run against the stub first.
- Start argv after the executable: `exec --json --sandbox workspace-write -C C:\Users\Study\AppData\Local\Temp\orchestration-m11-runtime-20260915-2245\repo -`; prompt on stdin. Exit 0 after **16,771 ms**, stdout **9 JSONL lines**, stderr empty. It created only untracked `hello.txt` with `Hello from M11.` and returned a UUID session id.
- Resume argv: `exec resume --json -c sandbox_mode="workspace-write" <exact-start-session-id> -`; prompt on stdin; child `cwd` remained the throwaway root. Exit 0 after **17,908 ms**, stdout **9 JSONL lines**, stderr empty. `thread.started` returned the exact same session id and the file changed to `Hello again from M11.`. This confirms resume argv acceptance, exact-session selection, cwd workspace selection and context continuity. The explicit config override was accepted while user config remained `danger-full-access`; writes stayed inside the intended workspace.
- Both raw streams had the same shape: `thread.started` → `turn.started` → completed `agent_message` → started/completed `file_change` → started/completed `command_execution` (exit 0) → completed `agent_message` → `turn.completed`. There were no error or reasoning events, malformed/non-JSON lines, unknown events or duplicate terminals. Normalized order was `session_started` → `message_delta` → `command_started` → `command_completed` → `message_delta` → `usage_reported` → `run_completed`, with exactly one usage before one terminal.
- Start usage: input 57,058; cached input 49,664; cache-write input 0; output 331; reasoning 28; total 57,389. Resume usage: input 119,922; cached input 110,080; cache-write input 0; output 643; reasoning 28; total 120,565. Each run reported usage exactly once and separately. `UsageSnapshot` has no cache-write field, so that observed field remains documented rather than added to the domain.
- Real `file_change` paths were absolute. The adapter now accepts only project-contained paths and normalizes them to portable relative paths (`hello.txt`); outside paths are discarded, and the existing Git-status fallback applies when none remain.

### Captures, safety and verification

- Field-whitelisted fixtures: `live-start-missing-host-v0.154.0-alpha.6.2.jsonl`, `live-start-v0.154.0-alpha.6.2.jsonl` and `live-resume-v0.154.0-alpha.6.2.jsonl`. They retain event names, nesting, order, statuses, exit codes and real usage; session/item ids, absolute paths, command output, machine details and prompt-derived text are replaced. Raw scans found no API-key/authorization/password/access-token patterns; raw absolute paths, session ids and prompt phrases were removed from fixtures.
- Final throwaway Git status was exactly `?? hello.txt`; no file was staged or committed after the initial repository commit. README SHA-256 stayed `6529B2F843E72D6291F35C6ABA72E93BDDBC8626CD63046D32ED357CB14966AE`; sentinel stayed `752250F26CFF7977CA79B4BE20DA2E9D2A59B2E22FC8A8C0237CF37B963EC7CE`. Final `hello.txt` SHA-256 was `7A98F309829C7B144F5503DB55075632126D3CC4428A0E54555863929F7795E8`.
- Raw captures `data/live-captures/codex-start-20260915-2245.raw.jsonl` and `data/live-captures/codex-resume-20260915-2245.raw.jsonl`, the harness, and its stub dry-run output are deleted by verified exact paths after final verification.
- Final offline verification: `npm test` 15 files / 197 tests, `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm run build` and `git diff --check` all pass.
- Still unverified at M11 completion: live Claude review (completed later in M12), the full orchestrator loop with both real CLIs, timeout behaviour on a long real run, a real permission denial, and whether the sandbox would block a deliberate out-of-root write (not attempted).

## Live Claude review validation (session 10, M12 — done)

### Preflight and invocation

- The task authorized exactly one real Claude review start after all offline gates passed. M12 ran
  **one Claude start, zero retries, zero Claude resumes, and zero Codex/other model calls**.
- Current executable: `C:\Users\Study\AppData\Local\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\Claude\claude-code\2.1.260\claude.exe`; `--version` returned `2.1.260 (Claude Code)`. `--help` still listed `--print`, `--output-format stream-json`, `--verbose`, `--permission-mode`, `--permission-prompts`, and `--json-schema`; `auth status` exited 0 and reported logged in. Account identifiers are not recorded here or in fixtures.
- Production review argv after the executable was exactly `--print --output-format stream-json --verbose --permission-mode plan --permission-prompts none --json-schema <review schema>`. There was no `--max-turns`, resume, continue, or bypass option. The 2,013-byte prompt went only to stdin; child `cwd` was the canonical throwaway repository.
- The first candidate throwaway (`C:\Users\Study\AppData\Local\Temp\orchestration-m12-review-20260915-235914\repo`) was owned by the offline sandbox account. The elevated real-run account therefore made Git reject it as dubious ownership. The harness stopped at review-context collection, before constructing the adapter or starting Claude, so this consumed no model call or tokens. No global `safe.directory` exception was added.
- A fresh real-run-owned repository was created at `C:\Users\Study\AppData\Local\Temp\orchestration-m12-review-20260916-000412-study\repo`. Its committed `calculator.js` returned `a + b`; the sole working-tree change replaced that with `a - b`. `GitReviewContextCollector` scoped the 194-byte context to exactly `calculator.js`, untruncated with no omissions. In-memory checks found one begin/end marker pair and both expected diff lines, with no sentinel content. The same production collector/prompt/adapter/parser path passed a stub dry-run before the model call.

### Live result and protocol

- The one live start exited 0 after **18,305 ms** (harness wall time 18,306 ms), with **9 JSONL lines** and empty stderr. It returned session id `21dca74b-58c3-43a8-81a2-c588e0141bf2`; it was not resumed.
- Raw event order: `rate_limit_event` → `system/init` → `assistant(thinking)` → `assistant(StructuredOutput)` → `user(tool_result)` → `assistant(StructuredOutput)` → `user(tool_result)` → `rate_limit_event` → `result/success`. The thinking string was empty. The first StructuredOutput attempt received an error tool result and the second succeeded; both are parser-known ignored events. There were no malformed or unknown lines.
- The terminal carried `is_error: false`, `terminal_reason: "completed"`, `stop_reason: "tool_use"`, `num_turns: 3`, no permission denials, and a schema-valid `structured_output`. Normalized order was exactly `session_started` → `usage_reported` → `run_completed`, with one usage event before one terminal and no text/reasoning events.
- Raw usage: input 4, cache creation 36,318, cache read 33,923, output 635, thinking 32. Mapped usage: input **70,245**, cached input **33,923**, output **635**, reasoning **32**, total **70,880**, source `actual`.
- Verdict was `request_changes`. The review specifically identified `return a - b` as subtraction rather than the required addition, requested restoring `a + b`, and requested a non-symmetric-operand regression test. This satisfies the deliberate-defect acceptance check without a retry.

### Safety, fixture and remaining gaps

- The final throwaway state remained exactly ` M calculator.js`; HEAD stayed `b7c53deacbe34b34b34e8c7fceadfe86a2a62c43`. `calculator.js` stayed byte-identical at SHA-256 `75CFACB7FAAC086C50B23AC4B29A709EB8680999E6756F620CA76D42ABA07CAB`; parent `SENTINEL.txt` stayed `DC91B476279EE67C930FACBE3EA19D7BBF5A5FE9E09477B29FCBE959313D83F9`. No extra repository or parent file appeared, and no `~/.claude/plans/` file was created.
- `tests/fixtures/claude/live-review-v2.1.260.jsonl` is a 9-line field-whitelisted capture. It replaces session/UUID/tool payloads, removes paths, account/machine data, prompt text and timings, and preserves event order, the sanitized review result, and real usage values. Three parser/adapter regressions cover event/terminal ordering, usage mapping, defect verdict, and fixture sanitization. Production adapter/parser code did not need to change.
- The raw scan found the expected absolute Windows paths and real session identifier, but no prompt,
  email, access/refresh token, authorization, bearer, password, or client-secret text. The sanitized
  fixture contains none of those machine/session values.
- Exact cleanup removed `data/live-captures/m12-stub.raw.jsonl`,
  `data/live-captures/m12-stub-study.raw.jsonl`,
  `data/live-captures/m12-claude-review-20260916-0006.raw.jsonl`,
  `data/live-captures/m12-live-review-harness.mjs`, and
  `data/live-captures/m12-tee-wrapper.mjs`. Final offline verification passed: `npm test` 15 files /
  200 tests, `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm run build`, and
  `git diff --check`.
- Remaining live gaps: Claude resume; the full orchestrator plan → approve → implement → review loop with both providers; long-run timeout/cancellation; a real permission denial; and deliberate out-of-root sandbox rejection (not attempted).

## Live two-provider orchestrator validation (session 11, M13 — partial)

### Preflight and bounded calls

- Baseline was `origin/main` commit `0ab254e`; work ran on `feature/live-e2e-validation`. Before any model call, the complete product suite passed at 15 files / 200 tests, both CLI versions/help/auth/runtime checks passed, and scripted approve/request-changes scenarios verified the production Orchestrator/SQLite/collector structure, `maxReviewRounds=1`, exact call order, persistence reopening and fourth-call rejection with zero model calls.
- Claude Code was `2.1.260`; Codex was `codex-cli 0.154.0-alpha.6.2` from a complete Desktop runtime containing all three required sibling helpers. The `.codex/.sandbox-bin` copy was not used. Discovered executable paths were passed only to the ignored one-off harness and were not added to product code.
- The user authorized at most three ordered calls. M13 made exactly **two**: Claude `plan` start once, then Codex `implement` start once. There were no retries, Codex resumes, Claude review starts/resumes, revisions, or other model/API calls. The third call was not made because the implementation guard failed.

### Observed live result

- Claude plan completed in **40,503 ms** with a stored session and a valid three-step plan: create `greet.js`, create a `node:test` test, then run `npm test`. Normalized adapter order was `session_started → usage_reported → run_completed`. Usage was input **328,971**, cached input **253,876**, output **1,721**, reasoning **601**, total **330,692**, source `actual`.
- Codex implementation reached a provider completion in **39,360 ms**, created only `greet.js` and `greet.test.js`, and ran `npm test` successfully (1 test, 0 failures). Its normalized stream before the guard contained `session_started`, four command starts/completions, `usage_reported`, then the guard substituted `run_failed(M13_POST_IMPLEMENT_GUARD)` for `run_completed`. Usage was input **97,143**, cached input **88,576**, output **829**, reasoning **129**, total **97,972**, source `actual`.
- Root cause: Codex reported the test as a command string wrapped by the Desktop runtime's PowerShell host: `"<runtime>\\pwsh.exe" -Command 'npm test'`. The parser recognised direct `npm test` commands only, so `testsPassed` remained `null`. The one-off guard required `testsPassed === true` and correctly prevented a review from starting even though the files and independent test were valid.
- The parser now recognises test commands only after a PowerShell executable plus its `-Command` boundary. A field-whitelisted fixture preserves the wrapper shape, exit code and observed usage while replacing the runtime path and output. Parser and adapter regression tests prove `testsPassed=true`; direct-command, failed-command, structured-error, usage-before-terminal and single-terminal behaviours remain covered.
- Persisted state transitions were `draft → awaiting_approval → queued → implementing → failed`; final failure was `M13_POST_IMPLEMENT_GUARD`, `reviewRound=0`, with no review record. The persisted timeline had 24 events; the two runs, four messages and two usage records reopened identically from SQLite. Aggregate task/project usage was input **426,114**, cached input **342,452**, output **2,550**, reasoning **730**, total **428,664**, all actual. Review markers and unified-diff text were absent from storage.

### Workspace and cleanup

- Throwaway parent: `C:\Users\Study\AppData\Local\Temp\orchestration-m13-e2e-20260916-004217-study`; repository: its `repo` child; retained DB: `m13.sqlite`. Initial HEAD remains `ac517dbb9d0df4ea1f02c6f2caf2b2dfa6680a98`; final status is exactly `?? greet.js` and `?? greet.test.js`. `package.json`, `README.md` and the parent sentinel retained their initial hashes, no dependency was added, and the product DB hash remained `52A371445CE0812CA930AEA418E7D7E9D6459F1778A6E14CB56592F08F5A08AF`.
- The Claude plan start created one user plan file at `C:\Users\Study\.claude\plans\do-not-add-external-pure-flame.md`; it was recorded by path and left intact. No raw provider stream was retained. The exact ignored harness path `D:\PersonalProject\Orchestration_bot\data\live-captures\m13-live-e2e-harness.mjs` was removed after offline regression work.
- M13 remains **partial** as its own execution and was never retried. M14 later validated the exact plan-session review resume, bounded live review prompt, approval verdict and completed continuation state without repeating the M13 model calls.

## Exact-session review continuation (session 12, M14 — done)

### Token-free continuation and live call

- Baseline was `origin/main` commit `5d9f361`; work ran on `feature/live-e2e-review-resume`. Initial verification passed at 15 files / 202 tests plus typecheck, lint, format, build and diff check. Claude Code remained `2.1.260`; version/help/auth and print, stream-json, verbose, plan/no-prompts, schema and resume support all passed.
- The existing M13 DB was opened read-only. It contained the real plan, plan/implementation runs, non-empty Claude session and actual historical usage. SHA-256 was `2EB5BC4FEBE768B959C89B20EE74475EADDBB80DAB2680680DA447D9EFB2C2A1` before and after M14.
- A composite adapter replayed the stored plan/session and the observed `greet.js` / `greet.test.js`, `testsPassed=true` implementation. These replay runs used `source=unavailable`, so M13 tokens were not counted again. Neither replay invoked Claude or Codex.
- Stub dry-runs proved approve → `completed`, request-changes → `REVIEW_ROUNDS_EXCEEDED`, exact session propagation, SQLite reopen, prompt/diff non-persistence and second-call rejection before the adapter. The real-call budget allowed only Claude `review` resume.
- M14 made exactly **one** real Claude resume and zero Claude starts, Codex calls, retries or other model/API calls. Safe argv was `--print --output-format stream-json --verbose --permission-mode plan --permission-prompts none --json-schema <schema> --resume <session>`; prompt was stdin and cwd/root was the M13 throwaway.

### Review result and persistence

- The Claude child exited 0. The persisted review run lasted **10,134 ms**. Five JSONL lines were observed: `system/init → assistant(StructuredOutput) → user(tool_result) → rate_limit_event → result/success`; unknown and malformed counts were zero.
- Normalized order was `session_started → usage_reported → run_completed`, with exactly one usage before one terminal. The returned and persisted review session matched the M13 plan session; only the equality boolean was recorded.
- `ReviewResultSchema` accepted `approve` with no change requests. The reviewer confirmed the exact greeting template, ESM export/imports, one normal-name `node:test`, no dependencies and no extra files, while explicitly noting that the test was statically inspected rather than executed by the reviewer.
- Actual review usage was input **76,950**, cached input **0**, output **274**, reasoning **0**, total **77,224**. The M14 aggregate has two unavailable replay records plus this actual review; cumulative historical M13+M14 actual total is **505,888** without duplication.
- State transitions were `draft → awaiting_approval → queued → implementing → review_requested → reviewing → approved → completed`; `reviewRound=1`. The M14 DB contains one project/task/review, three runs, six messages, three usage records and 22 timeline events. Two independent read-only reopen snapshots matched, and review markers/unified diff were absent.
- The production collector scoped exactly `greet.js` and `greet.test.js`: 366 bytes, no omissions/truncation. The in-memory review prompt was 2,689 bytes with one begin/end marker pair and no committed-file, sentinel or product-root content.

### Safety and observation note

- Throwaway HEAD stayed `ac517dbb9d0df4ea1f02c6f2caf2b2dfa6680a98`; final status remained exactly `?? greet.js` and `?? greet.test.js`. All four file hashes, sentinel and product DB hash were unchanged. Throwaway `npm test` passed one test. The single existing Claude plan file remained unchanged by path/count/timestamp.
- SQLite read-only connections updated the existing `m13.sqlite-shm` sidecar timestamp; the `m13.sqlite` content hash stayed unchanged and its WAL remained empty.
- Retained M14 DB: `C:\Users\Study\AppData\Local\Temp\orchestration-m13-e2e-20260916-004217-study\m14.sqlite`, SHA-256 `B094B7B0017CCC6D38A04C59A8DB2A43E4E449C1525E66C4FE5F0DBCDFEF11ED` at post-run verification.
- The observer summary was written just after the main harness attempted to read it. Consequently the outer harness reported exit 1 after the already-persisted successful terminal. No retry occurred. The later summary recorded child exit 0 and the five safe event types; independent DB/hash checks confirmed the completed result. No raw provider stream was stored.
- Remaining live gaps: one uninterrupted three-call execution; long-run cancellation/timeout; a real permission denial; deliberate out-of-root sandbox rejection.

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
- Verified with temporary git repositories and fake adapters only (no model is involved in diff collection). The diff has not yet been exercised inside a live review prompt.

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
- Review prompts include a bounded git diff (added afterwards in session 5, M9); Claude permissions were not widened for it.

## Asynchronous planning (session 3)

- `Orchestrator.submitRequest` persists the `draft` task, the user message and a `request_received` timeline entry, registers the planning pipeline **synchronously** and returns the draft. `whenSettled(taskId)` right after it waits for planning.
- `startPipeline(taskId, body)` is the single registry for planning and implementation pipelines: one active pipeline per task, an `AbortController` per pipeline, cleanup removes only its own entry, unexpected errors → task `failed` + `system_error`, abort-driven early return → no error.
- `runPlanning`: draft → Claude plan run → (`awaiting_approval` + plan + session + Claude message) | `failed` (planner error preserved, else `AGENT_RESULT_INVALID`). If the task left `draft` meanwhile (cancel/reject) the result is discarded.
- `cancel` aborts the planner, waits for the pipeline, then moves to `cancelled`. `reject` moves to `cancelled` first, then aborts. Neither produces `system_error`; a planner that ignores the abort and completes late is still ignored (tested).
- `recoverInterrupted`: `draft` tasks and their running plan runs are failed with `INTERRUPTED` (no automatic re-plan). Tasks with a live pipeline are skipped, so calling it twice is harmless.
- HTTP: `POST /api/requests` → **202** `{ task: <draft> }`. Approve while `draft` → 409.
- UI: submit selects the returned draft and shows "Claude is preparing a plan…"; Approve/Reject only in `awaiting_approval`; Cancel available in `draft`. `isStale`/`mergeTask` compare `updatedAt` so a late HTTP draft response cannot roll back an SSE `awaiting_approval` already applied.
- Tests use `tests/helpers/gated-adapter.ts` (test-only) to park the planner at a gate — no timers.
- Not verified at the time: behaviour with a real, slow planner. (Session 6 later ran one live planner call successfully — it took ~18 s, which is exactly why planning is asynchronous. M11 later completed the Codex live start/resume validation.)

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
- Result: `implementation` with summary = last agent message (≤ 2000 chars), project-contained `changedFiles` normalized to portable relative paths from `file_change` items else `git status --porcelain` fallback (toggle `gitStatusFallback`), `testsPassed` from the exit code of the last recognised test command (`npm test`, `npx vitest`, `pytest`, …) else `null`.
- Terminal: exactly one; lines after it are ignored. Non-JSON / malformed / unknown lines are counted and skipped. Process exit without a completion → `run_failed` (`TIMEOUT` / `CANCELLED` / `SPAWN_FAILED` / `CODEX_EXITED_WITHOUT_RESULT`) with a ≤ 500-char stderr tail.
- Process runner: `spawn(file, args, {shell:false, windowsHide:true})`, env = `BASE_ENV_KEYS` (PATH/HOME/USERPROFILE/SYSTEMROOT/TEMP/TMP/COMSPEC/PATHEXT) + explicit allowlist, stdout/stderr tails capped at 2 MiB, SIGTERM → SIGKILL after `killGraceMs` (5 s default; Windows additionally `taskkill /pid <pid> /T /F` via argv), children tracked and killed on `exit`/SIGINT/SIGTERM, one summary log line per run (executable, argc, cwd, outcome, exit code, ms).

### Live verification and remaining risks

- M11 confirmed live `thread.started`, `turn.started`, completed `error`, `agent_message` and `file_change` items, started/completed `command_execution`, and `turn.completed.usage` on 0.154.0-alpha.6.2. No live reasoning item appeared.
- `exec resume --json -c sandbox_mode="workspace-write" <sessionId> -` accepted the exact start session id, returned the same id and modified the expected file under the child `cwd`; no `-C` was needed on this version.
- An explicit absolute Windows `codex.exe` is now rejected before a run when its sibling Desktop runtime components are missing. PATH-based `codex` remains spawn-resolved and cannot be preflighted without changing its semantics.
- Approval prompts in non-interactive mode: behaviour unknown; currently surfaces as `TIMEOUT`.
- Live runs create normal session rollouts under `~/.codex/sessions/`. This expected CLI state lies outside the project root.
- The successful run demonstrated in-root writes under `workspace-write`; a deliberate out-of-root write was not attempted, so denial behaviour remains unverified.
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

## Role handoff (end of the Claude-led bootstrap)

M0–M10 were built and validated by Claude Code at the user's explicit request. That bootstrap phase is finished.

- **Default implementer from here on: Codex.** The current execution document is `docs/CODEX_NEXT_TASK.md` (M14).
- **Claude's runtime role stays planner / reviewer** (`plan` and `review` runs only, always `--permission-mode plan`).
- During development Claude can still be asked by the user to plan, review, write documentation, or implement a specific piece — that needs an explicit request, exactly as M0–M10 did. Nothing here forbids it.
- Real AI invocations (Claude or Codex) happen only inside a per-task approval the user granted, with the expected call count stated beforehand. There is no standing approval.
- Unchanged guardrails: state transitions go through `src/domain/state-machine.ts`; child processes use `runProcess` (argv array, `shell: false`, canonical cwd, env allowlist); no commit/push unless the user asks.

## Next exact work

1. If still valuable, validate one uninterrupted live plan → approve → implement → exact-session review → complete run under a new explicit call budget. M13+M14 already establish this path cumulatively.
2. Validate real cancellation/timeout/permission-denial behaviour only under a separately approved bounded task.
3. Then evaluate an explicitly gated emergency-repair path and/or packaging.
