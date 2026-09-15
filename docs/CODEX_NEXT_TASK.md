# CODEX_NEXT_TASK — M14 exact-session review continuation

> M13 live-ran the real Claude plan and Codex implementation, then stopped before review when its
> validation guard exposed the now-fixed Windows PowerShell test-command parser gap. M14 completes
> the remaining review path without repeating either earlier model call.

## 0. Hard limits

- Authorized live calls: at most one Claude `review` resume using the exact M13 plan session.
- Forbidden live calls: Claude plan/review start, Codex start/resume/revise, a second Claude resume,
  any other model/API call, retry, install, update, or login.
- Use the existing M13 throwaway only. Never pass this product repository as agent root, cwd,
  prompt subject, or review diff.
- Do not modify `m13.sqlite`. Store M14 state in a separate SQLite file.
- Session values, prompt/diff bodies, account/auth data and raw provider output must not be printed,
  persisted in product files, or included in documentation.
- No production dependency or permission/sandbox changes. A later explicit user instruction authorizes committing, pushing, and opening a PR for the verified M14 documentation changes.

## 1. Offline preflight

Before the model call:

1. Fetch `origin/main`, start clean branch `feature/live-e2e-review-resume` at `5d9f361`, and read
   repository instructions plus status/protocol/architecture files.
2. Run `npm test`, `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm run build`, and
   `git diff --check`.
3. Read `m13.sqlite` with `DatabaseSync(..., { readOnly: true })`; verify its task, plan, plan and
   implementation runs, actual usage, and non-empty Claude session without printing that session.
4. Verify the M13 DB hash, throwaway owner/HEAD/status/file hashes, sentinel and product DB hash.
   Do not add a global `safe.directory` exception.
5. Discover and check the current Claude executable with `--version`, `--help`, and `auth status`.
   Require print, stream-json, verbose, plan/no-prompts, schema and resume support.
6. Re-run the M13 parser fixture and prove the PowerShell-wrapped `npm test` is recognised while an
   unrelated PowerShell argument containing the same text is not.

Any failed preflight stops before a model call.

## 2. Continuation harness

Use the production Orchestrator, SQLite repositories, GitReviewContextCollector, prompt builder,
state machine, process runner, ClaudeCliAdapter.resume and ClaudeJsonlParser.

- Composite Claude plan `start`: replay the stored M13 plan and session; never invoke a CLI.
- Codex implement `start`: replay the observed `greet.js` / `greet.test.js`, `testsPassed=true`
  implementation; never invoke Codex.
- Replay usage: `source=unavailable`, so historical M13 tokens are not counted a second time.
- Claude review `resume`: the only path allowed to consume the one-call budget and delegate to the
  real adapter.
- `maxReviewRounds=1`: approval completes; request-changes ends with the existing bounded failure.
- A second attempted live call must fail before the underlying adapter is entered.

Dry-run both approve and request-changes outcomes with stubs. Require the exact stored session,
two-file 366-byte context, one begin/end marker pair, no omission/truncation, completed/bounded state
paths, SQLite reopen equality, and absence of prompt/diff content from persistence.

## 3. Live acceptance

- Exactly one Claude resume; `kind=review`; exact M13 plan session; no `--continue` or start fallback.
- Permission mode `plan`, permission prompts `none`, schema supplied, prompt on stdin, cwd/root equal
  the M13 throwaway.
- Record only safe argv shape, exit code, duration, JSONL event types/counts, normalized events,
  session equality boolean, validated review result, usage and unknown/malformed counts.
- `approve`: review round 1, one review record, task `completed`.
- `request_changes`: review round 1, `REVIEW_ROUNDS_EXCEEDED`, no further call.
- Close/reopen the new DB and compare task, runs, review, messages, timeline and usage.
- Confirm review prompt markers/diff are absent from DB/logs and all M13/product hashes stay fixed.

## 4. Observed result — 2026-09-16

M14 **completed** the requested continuation.

- Baseline `origin/main`: `5d9f361`; branch: `feature/live-e2e-review-resume`.
- Offline baseline: 15 test files / 202 tests plus typecheck, lint, format, build and diff check passed.
- Current Claude: `2.1.260 (Claude Code)`; version/help/auth and all required options passed.
- Dry-run actual model calls: zero. Approve completed; request-changes produced
  `REVIEW_ROUNDS_EXCEEDED`; a second review attempt was blocked before its stub adapter.
- Parser regression: wrapped test recognised, unrelated argument ignored, one usage before one
  terminal; direct and failed-command suites remained green.
- Production collector: only `greet.js` and `greet.test.js`, 366 bytes, no omissions/truncation;
  review prompt 2,689 bytes with one marker pair and no committed/sentinel/product content.

The authorized live call count was exactly one Claude review resume. Claude/Codex start and every
Codex call were zero; there was no retry. The exact M13 session was used and the returned/recorded
review session matched it. Safe argv after the executable was:

```text
--print --output-format stream-json --verbose --permission-mode plan
--permission-prompts none --json-schema <schema> --resume <session>
```

The Claude child exited 0 after a 10,134 ms persisted review run. Its five JSONL event types were:

```text
system/init → assistant(StructuredOutput) → user(tool_result) → rate_limit_event → result/success
```

They normalized to `session_started → usage_reported → run_completed`; usage and terminal each
occurred once in that order, with unknown/malformed counts both zero. `ReviewResultSchema` accepted
an `approve` verdict with no change requests. The reviewer found the exact greeting implementation,
ESM exports/imports, one normal-name `node:test`, and no dependencies or extra files; it explicitly
noted that it statically reviewed rather than independently running the test.

Actual M14 review usage: input 76,950; cached input 0; output 274; reasoning 0; total 77,224. The two
replayed runs remain `unavailable` in M14 storage and do not duplicate M13's historical 428,664
tokens. Cumulative historical actual usage across M13 and M14 is 505,888 total tokens.

The M14 task transitioned:

```text
draft → awaiting_approval → queued → implementing → review_requested → reviewing → approved → completed
```

It persisted review round 1, one approval review, three runs, six messages, three usage records and
22 timeline events. Independent read-only reopen snapshots matched. Review markers and unified diff
text were absent from storage.

The observer summary was written just after the main harness tried to read it, so the outer harness
reported exit 1 after the already-persisted successful terminal. This post-terminal observation race
did not trigger or retry a model call; the summary later confirmed the Claude child exit 0 and the
event facts above. The M14 DB and independent persistence/hash checks establish the completed result.

M13 DB SHA-256 remained
`2EB5BC4FEBE768B959C89B20EE74475EADDBB80DAB2680680DA447D9EFB2C2A1`. Throwaway HEAD/status and all
four file hashes, sentinel, product DB, and the single pre-existing Claude plan file remained
unchanged. Throwaway `npm test` passed one test. SQLite read-only connections updated the existing
`m13.sqlite-shm` sidecar timestamp, but the `m13.sqlite` hash was unchanged and its WAL stayed empty.

## 5. Remaining boundary

M13 plus M14 are a cumulative continuation: real plan, real implementation and exact-session real
review all succeeded across the two milestones. They are not evidence of one uninterrupted process
performing all three calls. Live cancellation, timeout, permission-denial and deliberate
out-of-root sandbox rejection also remain unverified.
