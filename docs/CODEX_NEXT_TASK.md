# CODEX_NEXT_TASK — Real Codex CLI adapter

Implement `CodexCliAdapter`, a production `AgentAdapter` that runs the real `codex` CLI, so the orchestrator can drive Codex instead of `FakeCodexAdapter`. Do not touch the Claude side.

## 1. Read first (in this order)

1. `AGENTS.md` — your rules in this repo.
2. `src/infrastructure/agents/agent-adapter.ts` — the interface you implement.
3. `src/domain/agent-events.ts` — the normalized event union you must emit.
4. `src/domain/usage.ts` — `UsageSnapshot` and the `actual | estimated | unavailable` rule.
5. `src/infrastructure/agents/fake-codex-adapter.ts` — reference for event ordering.
6. `src/application/orchestrator.ts` — only `executeRun()` (how your stream is consumed; it stops at the first `run_completed` / `run_failed`).
7. `docs/ARCHITECTURE.md` § "Process safety policy".

## 2. Deliverables

| File                                                   | Purpose                                                                                                                                                 |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/infrastructure/process/process-runner.ts`         | Safe `spawn` wrapper: args array, `shell: false`, cwd validation, env allowlist, timeout, abort, separate stdout/stderr, line-delimited stdout iterator |
| `src/infrastructure/agents/codex-jsonl-parser.ts`      | Pure function(s): one Codex JSONL line → zero or more `AgentEvent`s + parser state (session id, accumulated usage)                                      |
| `src/infrastructure/agents/codex-cli-adapter.ts`       | `CodexCliAdapter implements AgentAdapter` using the two above                                                                                           |
| `tests/fixtures/codex/*.jsonl`                         | Captured / hand-written Codex output samples                                                                                                            |
| `src/infrastructure/agents/codex-jsonl-parser.test.ts` | Parser unit tests against fixtures                                                                                                                      |
| `src/infrastructure/process/process-runner.test.ts`    | Runner tests using `node` as the child (e.g. `node -e "..."`) — never the real `codex`                                                                  |
| `tests/integration/codex-cli-adapter.test.ts`          | Adapter tests with a stub executable (a small Node script that replays a fixture to stdout)                                                             |

## 3. Expected CLI invocation

Verify flags against `codex --help` / `codex exec --help` on the machine before finalizing; adjust and document in the file header.

```
codex exec --json --sandbox workspace-write --cd <projectRoot> [--skip-git-repo-check] -
```

- Prompt is written to **stdin** (the trailing `-`), not passed as an argument.
- Resume: `codex exec resume <sessionId> --json ... -` (confirm exact subcommand shape on the installed version; if resume with `--json` is unsupported, fall back to `start` and set `sessionId` to the new id, and note it in the report).
- Approval policy: leave the CLI default (`on-request` / `untrusted`) or the safest available non-interactive mode. If the CLI blocks waiting for approval, emit `run_failed` with code `APPROVAL_REQUIRED_BY_CLI`.

**Forbidden flags**: `--dangerously-bypass-approvals-and-sandbox`, `--yolo`, `--full-auto`, `--sandbox danger-full-access`, `-a never`. Add a unit test that asserts the built argv never contains them.

## 4. Process runner contract

```ts
interface SpawnOptions {
  file: string; // executable name or absolute path
  args: string[];
  cwd: string; // must already be canonical and inside projectRoot
  projectRoot: string;
  env?: Record<string, string>; // ONLY these keys are passed, plus PATH / HOME / USERPROFILE / SYSTEMROOT / TEMP / TMP
  stdin?: string;
  timeoutMs: number;
  signal?: AbortSignal;
  maxOutputBytes?: number; // default 2 MiB per stream; beyond that keep the tail and mark truncated
}
```

- `cwd` check: `realpath(cwd)` must equal or start with `realpath(projectRoot) + path.sep`. Throw `OrchestrationError('INVALID_PROJECT_ROOT')` otherwise.
- `shell: false`, `windowsHide: true`.
- On timeout or abort: `SIGTERM`, then `SIGKILL` after 5 s. On Windows use `child.kill()` and, if needed, `taskkill /pid <pid> /T /F` via `spawn` (args array).
- Expose `stdoutLines(): AsyncIterable<string>` plus `stderrTail` and `exitCode` after completion.
- Register children in a module-level set and kill all of them on `process.on('exit' | 'SIGINT' | 'SIGTERM')`.
- Never log the prompt or full stdout. Log at most: executable, arg count, cwd, exit code, duration.

## 5. JSONL normalization rules

Codex `--json` prints one JSON object per line. Map as follows (adapt names to the real schema you observe; keep the mapping table in the parser file header):

| Codex line                                           | AgentEvent                                                                               |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| thread/session started with an id                    | `session_started { sessionId }`                                                          |
| agent message text (final or delta)                  | `message_delta { text }`                                                                 |
| reasoning text                                       | `reasoning_delta { text }`                                                               |
| command execution begin (`command`, `cwd`)           | `command_started { commandId, command: string[], cwd }`                                  |
| command execution end (`exit_code`, output)          | `command_completed { commandId, exitCode, stdoutTail, stderrTail }` (tails ≤ 2000 chars) |
| token usage / turn complete with usage               | `usage_reported { usage }` with `source: 'actual'`                                       |
| turn/thread complete without error                   | `run_completed { result }` (see § 6)                                                     |
| error line, or process exit ≠ 0 without a completion | `run_failed { error: { code, message } }`                                                |

Unknown line types: ignore, but count them; include the count in the run_failed message if the run never completes.

Non-JSON lines on stdout: ignore (Codex may print banners). Malformed JSON: ignore.

## 6. Building the `implementation` result

The orchestrator requires `run_completed.result.kind === 'implementation'`. Build it as:

- `summary`: the last agent message text (≤ 2000 chars), or `'Codex run completed.'`
- `changedFiles`: files from file-change events if the JSONL has them; else run `git status --porcelain` inside `projectRoot` via the process runner and parse paths; else `[]`.
- `testsPassed`: `true` if a `command_completed` whose command starts with `npm test` / `npx vitest` / `pytest` etc. had `exitCode === 0`, `false` if it had a non-zero exit, `null` if no test command ran.

## 7. Token usage

- If Codex reports usage → `source: 'actual'`, copy fields; fields it does not provide are `null`.
- If a `usage_reported` was never emitted by the end of the run, emit exactly one `usage_reported` with `UNAVAILABLE_USAGE` (all null, `source: 'unavailable'`). Do **not** estimate in this task.

## 8. Session ID and resume

- Persist nothing yourself; the orchestrator stores `sessionId` from `session_started` on the task.
- `resume(sessionId, input)` must emit `session_started` with the same `sessionId` (or the new one if the CLI rotates ids).

## 9. Timeout and cancellation

- Default timeout: 15 minutes for `implement`/`revise`. Make it a constructor option.
- `cancel(runId)` aborts the run's controller; the stream ends with `run_failed { code: 'CANCELLED' }`.
- `input.signal` aborted → same as cancel.

## 10. Tests / fixtures

`tests/fixtures/codex/`:

- `happy-path.jsonl` — session, two messages, one `npm test` command (exit 0), usage, completion.
- `resume.jsonl` — same session id as happy-path, one message, completion.
- `command-failed.jsonl` — test command exits 1, completion (→ `testsPassed: false`).
- `no-usage.jsonl` — completion without usage (→ one `unavailable` record).
- `error.jsonl` — an error line (→ `run_failed`).
- `garbage.jsonl` — banner lines, malformed JSON, unknown types mixed with a valid run.

Adapter tests use a stub executable: `tests/fixtures/codex/stub-codex.mjs` that reads `STUB_FIXTURE` env var and streams that fixture to stdout line by line; pass `executable: process.execPath, extraArgs: [stubPath]` through a constructor option so the adapter spawns `node stub-codex.mjs ...` instead of `codex`. Never invoke the real `codex` binary in tests.

## 11. Wiring (small, last step)

In `src/server/main.ts`, select the adapter with `CODEX_ADAPTER=fake|cli` (default `fake`). Add the variable to `.env.example`. Do not change the default.

## 12. Completion criteria

- `npm test`, `npm run typecheck`, `npm run lint` all pass.
- All fixtures above exist and are exercised.
- Argv test proves forbidden flags are absent.
- Process runner test proves: cwd outside projectRoot is rejected; timeout kills the child; abort kills the child; stdout/stderr separated; output bounded.
- `docs/STATUS.md` updated: what you did, exact CLI flags observed on this machine, anything unverified.
- No commit, no push.

## 13. Allowed files

Create/modify only:

- `src/infrastructure/process/**`
- `src/infrastructure/agents/codex-jsonl-parser.ts`, `codex-cli-adapter.ts`, their `*.test.ts`
- `tests/fixtures/codex/**`, `tests/integration/codex-cli-adapter.test.ts`
- `src/server/main.ts` (adapter selection only), `.env.example`
- `docs/STATUS.md`

## 14. Do not modify

- `src/domain/**` (if you believe the event union must change, stop and report why instead)
- `src/application/**`
- `src/infrastructure/agents/agent-adapter.ts`, `fake-*.ts`
- `src/infrastructure/persistence/**`
- `src/server/app.ts`, `src/server/routes/**`, `src/server/events/**`
- `src/web/**`, `src/shared/**`
- `package.json` dependencies (no new runtime deps; ask if you think one is required)
