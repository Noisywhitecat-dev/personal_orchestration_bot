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

- Plan: `{ kind: 'plan', title, summary, steps: string[] }`
- Implementation: `{ kind: 'implementation', summary, changedFiles: string[], testsPassed: boolean | null }`
- Review: `{ kind: 'review', verdict: 'approve' | 'request_changes', summary, changeRequests: string[] }`

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

## Review loop bound

`Task.reviewRound` increments each time a review completes. If the verdict is `request_changes` and `reviewRound >= task.maxReviewRounds`, the task fails with `REVIEW_ROUNDS_EXCEEDED` and the user is notified.
