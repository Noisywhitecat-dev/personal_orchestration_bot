# Protocol

## Task states

```
draft -> awaiting_approval -> queued -> implementing -> review_requested -> reviewing -> approved -> completed
                                            ^                                   |
                                            +------- changes_requested <--------+
```

| State               | Meaning                                                                                  |
| ------------------- | ---------------------------------------------------------------------------------------- |
| `draft`             | Request persisted; Claude plan run pending or in flight (background). Not approvable yet |
| `awaiting_approval` | Plan produced, waiting for the user                                                      |
| `queued`            | User approved; waiting for implementer                                                   |
| `implementing`      | Codex run in progress                                                                    |
| `review_requested`  | Implementation finished; review not started                                              |
| `reviewing`         | Claude review run in progress                                                            |
| `changes_requested` | Review asked for changes; will re-enter `implementing`                                   |
| `approved`          | Review passed                                                                            |
| `completed`         | Terminal success                                                                         |
| `failed`            | Terminal failure (run error, review rounds exceeded, plan failure)                       |
| `cancelled`         | Terminal; user cancelled or rejected                                                     |

## Allowed transitions

| From                           | To                                             |
| ------------------------------ | ---------------------------------------------- |
| draft                          | awaiting_approval, failed, cancelled           |
| awaiting_approval              | queued (**requires user approval**), cancelled |
| queued                         | implementing, cancelled                        |
| implementing                   | review_requested, failed, cancelled            |
| review_requested               | reviewing, cancelled                           |
| reviewing                      | approved, changes_requested, failed, cancelled |
| changes_requested              | implementing, failed, cancelled                |
| approved                       | completed                                      |
| completed / failed / cancelled | (none)                                         |

Any other transition throws `OrchestrationError` with code `INVALID_TRANSITION`.
The `awaiting_approval -> queued` transition additionally requires an explicit approval flag; without it the error code is `APPROVAL_REQUIRED`.

## Planning is asynchronous

`POST /api/requests` persists the task as `draft`, registers a background planning pipeline and returns **202** with the draft immediately. The planner later moves the task to `awaiting_approval` (plan stored, Claude message added) or `failed`; clients follow this over SSE (`task_updated`). `cancel` / `reject` are valid while `draft` and abort the planner; a late planner result never overrides `cancelled`. After a server restart, `draft` tasks are failed with `INTERRUPTED` (planning is not re-run automatically because that would spend tokens without the user asking).

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

- Plan: `{ kind: 'plan', title, summary, steps: string[] }` — `steps` must be non-empty
- Implementation: `{ kind: 'implementation', summary, changedFiles: string[], testsPassed: boolean | null }`
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

The plan/review result is taken from `structured_output`, else from a `result` string that is JSON or a single ```json fence. It is validated with a zod schema for the run kind (the same shape is passed as `--json-schema`). Anything else — missing fields, wrong `kind`, empty `steps`, bad `verdict`, `request_changes` without requests, prose — fails the run with `AGENT_RESULT_INVALID`. No default plan and no automatic approval is ever synthesized. The adapter supports only `plan` and `review`; `implement`/`revise` fail with `UNSUPPORTED_KIND` without spawning.

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

## Review context (ephemeral)

After a successful `implement` / `revise` run the orchestrator asks a `ReviewContextCollector` for a bounded snapshot of the working tree (git: `status --porcelain -z`, `diff --no-ext-diff --no-textconv --no-color --relative HEAD -- :(literal)path…`, plus untracked text files read directly). The result is embedded into the next review prompt between `<<<BEGIN_UNTRUSTED_REVIEW_CONTEXT>>>` / `<<<END_UNTRUSTED_REVIEW_CONTEXT>>>` markers together with the task, plan, implementation report and previous review rounds.

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
