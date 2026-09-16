# Protocol

## Task states

```
draft <-> awaiting_clarification
  |
  +-> awaiting_approval -> queued -> implementing -> review_requested -> reviewing -> approved -> completed
                                      ^                                   |
                                      +------- changes_requested <--------+
```

| State                    | Meaning                                                                                  |
| ------------------------ | ---------------------------------------------------------------------------------------- |
| `draft`                  | Request persisted; Claude plan run pending or in flight (background). Not approvable yet |
| `awaiting_clarification` | Claude asked a persisted question; waiting for one user answer or cancellation           |
| `awaiting_approval`      | Plan produced, waiting for the user                                                      |
| `queued`                 | User approved; waiting for implementer                                                   |
| `implementing`           | Codex run in progress                                                                    |
| `review_requested`       | Implementation finished; review not started                                              |
| `reviewing`              | Claude review run in progress                                                            |
| `changes_requested`      | Review asked for changes; will re-enter `implementing`                                   |
| `approved`               | Review passed                                                                            |
| `completed`              | Terminal success                                                                         |
| `failed`                 | Terminal failure (run error, review rounds exceeded, plan failure)                       |
| `cancelled`              | Terminal; user cancelled or rejected                                                     |

## Allowed transitions

| From                           | To                                                           |
| ------------------------------ | ------------------------------------------------------------ |
| draft                          | awaiting_clarification, awaiting_approval, failed, cancelled |
| awaiting_clarification         | draft, cancelled                                             |
| awaiting_approval              | queued (**requires user approval**), cancelled               |
| queued                         | implementing, cancelled                                      |
| implementing                   | review_requested, failed, cancelled                          |
| review_requested               | reviewing, cancelled                                         |
| reviewing                      | approved, changes_requested, failed, cancelled               |
| changes_requested              | implementing, failed, cancelled                              |
| approved                       | completed                                                    |
| completed / failed / cancelled | (none)                                                       |

Any other transition throws `OrchestrationError` with code `INVALID_TRANSITION`.
The `awaiting_approval -> queued` transition additionally requires an explicit approval flag; without it the error code is `APPROVAL_REQUIRED`.

## Planning is asynchronous

`POST /api/requests` persists the task as `draft`, registers a background planning pipeline and returns **202** with the draft immediately. The planner later moves to `awaiting_clarification`, `awaiting_approval`, or `failed`; clients follow this over SSE. `POST /api/tasks/:id/clarify` accepts one non-empty answer only while waiting, persists it, and starts one exact-session Claude resume. Multiple rounds are allowed up to the task limit. `cancel` / `reject` abort planning or clarification safely, and late results never override `cancelled`. After a server restart, an in-flight `draft` is failed with `INTERRUPTED`; planning is never re-run automatically because that would spend tokens without a fresh user action.

## Agent events (normalized)

Every adapter emits `AgentEvent` values with a common envelope `{ type, runId, timestamp, ...payload }`:

| type                | payload                                               |
| ------------------- | ----------------------------------------------------- |
| `session_started`   | `sessionId`                                           |
| `message_delta`     | `text`                                                |
| `reasoning_delta`   | `text`                                                |
| `command_started`   | `commandId`, `command: string[]`, `cwd`               |
| `command_completed` | `commandId`, `exitCode`, `stdoutTail?`, `stderrTail?` |
| `usage_reported`    | `usage: UsageSnapshot`                                |
| `run_completed`     | `result: AgentResult`                                 |
| `run_failed`        | `error: { code, message }`                            |

Provider-specific JSON (Codex JSONL, Claude stream-json) is parsed inside the adapter and never reaches domain/application.

`stdoutTail` / `stderrTail` exist only at this normalized in-memory boundary so parsers can classify
commands and failures. The orchestrator persists only the command id, exit code, and whether each
stream had content. Migration v3 removes legacy tails; the public DTO applies the same redaction as
defense in depth.

## AgentAdapter interface

```ts
interface AgentAdapter {
  readonly provider: 'claude' | 'codex';
  start(input: AgentRunInput): AsyncIterable<AgentEvent>;
  resume(sessionId: SessionId, input: AgentRunInput): AsyncIterable<AgentEvent>;
  cancel(runId: RunId): Promise<void>;
}
```

`AgentRunInput` carries `runId`, `taskId`, `projectRoot`, `kind` (`plan` | `implement` | `review` | `revise`), `prompt`, and an optional `AbortSignal`.

## Structured agent results

- Plan: `{ kind: 'plan', title, summary, steps: string[], objective?, scope?, outOfScope?, acceptanceCriteria?, suggestedFiles?, verification?, risks?, riskLevel? }`. New lists contain non-empty strings; riskLevel is low/medium/high. The original title/summary/non-empty steps remain required, so old stored plans remain readable.
- Clarification: `{ kind: 'clarification', question }` — the question must be non-empty
- Implementation: `{ kind: 'implementation', summary, changedFiles: string[], testsPassed: boolean | null, verificationResults?: string[], deviations?: string[], remainingRisks?: string[] }`. Structured Codex final JSON is validated; observed test-command outcomes take precedence. Legacy prose remains compatible. Malformed structured reports fail validation.
- Review: `{ kind: 'review', verdict: 'approve' | 'request_changes', summary, changeRequests: string[] }` — `request_changes` requires at least one change request

### Codex JSONL boundary

`CodexCliAdapter` runs start with `exec --json --sandbox workspace-write -C <root> -` and resume with `exec resume --json -c sandbox_mode="workspace-write" <sessionId> -`. Prompts are sent on stdin. `codex-jsonl-parser.ts` maps the provider lines as follows:

On Windows, an explicitly configured absolute `codex.exe` is validated before any run: the selected executable and sibling `codex-code-mode-host.exe`, `codex-command-runner.exe` and `codex-windows-sandbox-setup.exe` must all exist. An incomplete runtime fails configuration with `VALIDATION_FAILED`. PATH-based `codex` and non-Codex wrapper/stub executables are not forced into the private Desktop runtime layout, and the application does not scan private hash directories.

| Codex line                                      | AgentEvent                                                                                        |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `thread.started.thread_id`                      | `session_started`                                                                                 |
| `turn.started`                                  | known lifecycle event; no domain event                                                            |
| completed/updated `agent_message` item          | `message_delta`                                                                                   |
| started/completed `command_execution` item      | `command_started` / `command_completed`                                                           |
| completed `file_change` item                    | project-contained paths normalized to portable relative paths and accumulated into the result     |
| completed `error` item                          | records a pending structured failure                                                              |
| `turn.completed.usage`                          | `usage_reported` (`actual`)                                                                       |
| `turn.completed` with no pending error          | `run_completed`                                                                                   |
| `turn.completed` after a completed `error` item | `run_failed` after usage; this handles CLI turns that complete despite a failed command/tool host |
| `turn.failed` or top-level `error`              | `run_failed`                                                                                      |

The pending-error rule uses only the provider's structured `item.type = "error"`; it does not infer success or failure from agent prose. Usage is still emitted exactly once before the terminal event.

Test status is derived from the last recognised test command's completed exit code. Besides direct commands such as `npm test`, the parser recognises the Windows Desktop runtime shape `"<runtime>\\pwsh.exe" -Command 'npm test'` by inspecting only the script after a PowerShell `-Command` boundary. It does not treat arbitrary wrapper arguments containing test text as a test execution. M13 observed this shape in a real Codex implementation; prior to the fix it left `testsPassed=null`, and the external validation guard stopped the pipeline before review.

### Claude stream-json boundary

`ClaudeCliAdapter` runs `claude --print --output-format stream-json --verbose --permission-mode plan --permission-prompts none --json-schema <schema>` and `claude-jsonl-parser.ts` maps the provider lines to the normalized events above:

| Claude line                                | AgentEvent                                                                          |
| ------------------------------------------ | ----------------------------------------------------------------------------------- |
| `system`/`init` with `session_id`          | `session_started` (suppressed if it repeats a known id)                             |
| `assistant` text block                     | `message_delta` (whole block; partial messages are not requested)                   |
| `assistant` thinking block                 | `reasoning_delta`                                                                   |
| `result` usage                             | `usage_reported` (`actual`; `unavailable` when absent) — always before the terminal |
| `result` success + valid structured output | `run_completed`                                                                     |
| `result` error / `error_*` subtype         | `run_failed` (`CLAUDE_ERROR`)                                                       |

The plan/review result is taken from `structured_output`, else from a `result` string that is JSON or a single ```json fence. It is validated with a strict zod schema for the run kind. Anything else — missing fields, wrong `kind`, empty `steps`/question, bad `verdict`, `request_changes` without requests, prose — fails the run with `AGENT_RESULT_INVALID`. No default plan and no automatic approval is synthesized. The adapter supports only `plan` and `review`; `implement`/`revise` fail with `UNSUPPORTED_KIND` without spawning.

Claude Code 2.1.260 requires a top-level JSON Schema `type: "object"` and rejects top-level `oneOf`/`allOf`/`anyOf` for its custom structured-output tool. The planning schema is therefore one flat object with a required `kind` enum and optional branch fields; the strict discriminated zod union performs the final plan-versus-clarification validation. A regression test forbids top-level composition keywords.

M12 live-validated the review start boundary on Claude Code 2.1.260. The real stream used
`rate_limit_event → system/init → assistant(thinking) → assistant(StructuredOutput) → user(tool_result) → assistant(StructuredOutput) → user(tool_result) → rate_limit_event → result/success`.
The intermediate empty thinking/tool blocks remain known-ignored; only the terminal
`structured_output` becomes the schema-validated review result. The observed normalized order was
`session_started → usage_reported → run_completed`, with exactly one usage event before one terminal.

M14 live-validated review resume on the same Claude Code version using the exact session stored by
the M13 plan run. Safe argv shape was `--print --output-format stream-json --verbose
--permission-mode plan --permission-prompts none --json-schema <schema> --resume <session>`; there
was no `--continue` or review start fallback. The five raw event types were `system/init →
assistant(StructuredOutput) → user(tool_result) → rate_limit_event → result/success`, normalizing to
`session_started → usage_reported → run_completed` with one usage before one terminal and no
unknown/malformed lines. The schema-valid verdict was `approve`.

## Usage

```ts
interface UsageRecord {
  id; provider; projectId; taskId; runId; sessionId | null;
  inputTokens | null; cachedInputTokens | null; outputTokens | null;
  reasoningTokens | null; totalTokens | null;
  source: 'actual' | 'estimated' | 'unavailable';
  recordedAt;
}
```

Aggregates (`UsageSummary`) are computed from records and report `hasEstimated` / `hasUnavailable` flags so the UI can label them.

## Execution limits

Each task persists `maxClaudeRuns`, `maxCodexRuns`, nullable provider token ceilings, `maxClarificationRounds`, and `maxReviewRounds`. Immediately before every run, one centralized guard counts persisted provider runs and sums known usage. A reached run limit or token ceiling fails the task, records `budget_blocked`, and emits a user-facing system message without inserting a run or entering the provider adapter.

Token ceilings are **run-boundary ceilings**, not provider hard caps: usage is reported only after a call, so one call may cross its ceiling. When any usage record is `estimated` or `unavailable`, the public budget reports that confidence and omits a supposedly reliable remaining-token value. A null ceiling is unlimited.

REST and SSE use public DTOs that remove every session id. They expose only session-presence booleans. `GET /api/runtime-status` is token-free and returns adapter modes, executable readiness classifications, timeouts, review byte budget, database basename, and default limits—never executable paths, environment values, credentials, prompts, or diffs.

## Review context (ephemeral)

After a successful `implement` / `revise` run the orchestrator asks a `ReviewContextCollector` for a bounded snapshot of the working tree (git: `status --porcelain -z`, `diff --no-ext-diff --no-textconv --no-color --relative HEAD -- :(literal)path…`, plus untracked text files read directly). The result is embedded into the next review prompt between `<<<BEGIN_UNTRUSTED_REVIEW_CONTEXT>>>` / `<<<END_UNTRUSTED_REVIEW_CONTEXT>>>` markers together with the approved plan, current implementation report and latest unresolved change requests. The original request and full conversation are not repeated.

- The diff is **not** an `AgentEvent` and is **not** persisted anywhere (no Task/Run/Message/TaskEvent/usage/SSE/log). It exists only inside that one prompt string.
- A fresh snapshot is collected for every round; nothing from an earlier round is reused.
- Collection failures (not a git repo, git error, collector disabled) yield `unavailable`; the review still runs and the prompt says so. Truncation and omitted files (sensitive, binary, excluded dirs, outside root, symlink, too large) are stated explicitly.
- If the task is cancelled while collecting, no review run is started and the task ends `cancelled`.
- The snapshot describes the current working tree, not proven authorship; the implementer's `changedFiles` only narrow the scope.
- M12 exercised this path against one real, scoped `calculator.js` diff. The prompt contained one
  begin/end marker pair and the expected removed/added lines, while the read-only Claude review left
  the working tree byte-identical.
- M13 connected the real Orchestrator, SQLite, Claude plan start and Codex implementation. The
  post-implementation validation guard stopped before context collection/review because the live
  PowerShell-wrapped test command was not yet recognised. At the end of M13, Claude resume and
  full-loop review-context delivery therefore remained unverified.
- M14 resumed the exact M13 plan session without repeating either model start. A separate SQLite
  continuation replayed the historical plan/implementation with `unavailable` usage, collected the
  same two untracked files (366 bytes, no omission/truncation), and passed the bounded context to the
  real Claude reviewer. Approval drove the separate task through `reviewing → approved → completed`.
  This is cumulative M13–M14 evidence, not one uninterrupted three-call run.

## Review loop bound

`Task.reviewRound` increments each time a review completes. If the verdict is `request_changes` and `reviewRound >= task.maxReviewRounds`, the task fails with `REVIEW_ROUNDS_EXCEEDED` and the user is notified.

## M17 project tools and privacy

- GET /api/projects/:id/harness: version, fixed relative file list, proposed template contents and
  missing/installed/conflict/blocked/outdated status. Existing file content is never returned.
- POST /api/projects/:id/harness: strict body `{confirm:true}`. Uses only the stored project root;
  returns created/skipped paths and refreshed preview. Existing files always remain untouched.
- POST /api/projects/:id/preflight: path/Git/version/auth/model/effort/harness classifications and user guidance.
  No generation command or login mutation; stdout/stderr and credentials are neither persisted nor exposed.
- Browser POST requires same-origin when Origin is supplied. No CORS permission is added.
- Clarification resumes contain answer, current round and a short final-plan instruction. Codex revision resumes
  contain current changes and preserved acceptance criteria, not the original request/full plan.
- Installed exact-version role skills are referenced briefly. Missing/conflicting/modified skills do not remove
  the minimum role/safety instruction. Review context and metadata blocks are treated as untrusted data.
- New raw provider text and command argv/cwd are discarded at persistence boundaries. Command completion stores
  only exit/presence metadata. Provider errors are reduced to known codes and Korean recovery guidance.
  SQLite v4 removes historical agent_message text and command_started content with secure deletion and compaction.
- Diagnostic export reconstructs an object from whitelisted enums, integer counts and token totals. No arbitrary
  error text, identifiers, model strings, names, paths, prompts, diff, or command output are copied.
- On restart, queued/review_requested use the existing cancelled transition with INTERRUPTED metadata;
  draft/implementing/reviewing/changes_requested fail INTERRUPTED; approved completes without a provider call.
  Awaiting clarification/approval remain user-gated. Shutdown aborts and drains pipelines before DB close.

## Desktop account usage (M18)

The context-isolated bridge exposes getAccountUsage(refresh: boolean) and importClaudeUsage(text: string).
New IPC handlers require the current renderer origin. refresh=false reads only memory; refresh=true performs
a bounded Codex initialize/initialized/account/rateLimits/read exchange, coalesced and throttled for 15 seconds.
No thread, turn, login or credit-redemption request is sent. The API returns only known windows with kind,
usedPercent, nullable resetsAt (Unix seconds), observedAt (milliseconds), and source.
Claude execution events and explicitly imported statusline JSON are projected into the same whitelist.
Raw input and account credentials are not stored. Import is capped at 64KB. Unsupported/missing values stay absent;
expired windows do not display current remaining capacity. These snapshots are not task token consumption.

## M19 대화 삭제

`POST /api/tasks/:id/delete`에 `{ "confirm": true }`를 보낸다. 기존 POST의 same-origin 검사를 적용한다.
완료·실패·중단 상태이며 실행 파이프라인이 완전히 종료된 경우만 허용한다. 실행/승인 대기는 409,
확인 누락/false는 400, 없는 작업은 404다. 성공은 200 `{ "deleted": true }`.
작업·메시지·실행·타임라인·로컬 usage를 한 트랜잭션으로 삭제한다. 프로젝트와 파일은 건드리지 않는다.
성공 후 SSE `task_deleted`에 taskId/projectId를 보낸다. 클라이언트는 프로젝트를 다시 읽고
선택된 작업이 없으면 최근 남은 작업 또는 새 작업 화면으로 이동한다. 외부 CLI 세션 이력은 삭제하지 않는다.
