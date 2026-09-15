# CODEX_NEXT_TASK — M13 live two-provider end-to-end validation

> M10–M12 validated the individual live CLI paths. M13 connects those production components through
> the real application-layer `Orchestrator` and SQLite repositories for one minimal task.

## 0. Hard limits

- The M13 request authorizes, in this order only: one Claude `plan` start, one Codex `implement`
  start, and one Claude `review` resume using the exact plan session. Maximum: three model calls.
- Every next call requires the preceding stage to succeed. No retry, Codex resume, Claude review
  start, revision round, fourth call, other model/API call, install, update, or login.
- Set `maxReviewRounds` to 1. If review requests changes, stop with the resulting bounded failure;
  do not revise or review again.
- Use a fresh user-owned throwaway Git repository and a SQLite DB in its parent. Never pass this
  product repository as an agent root, cwd, prompt subject, or review diff.
- Use production `Orchestrator`, SQLite repositories, `GitReviewContextCollector`, both CLI adapters,
  existing prompt/state/parser code, and the existing process runner. The harness may configure and
  guard them but must not build provider argv itself.
- Prompt/diff/session/auth data must not appear in harness source or logs. Persist neither the review
  prompt nor diff.
- No dependency additions. The user explicitly requested a Korean commit, push, and PR after M13
  implementation and verification; that request supersedes the earlier no-commit handoff default
  for this task only.

## 1. Offline preflight

Before any model call:

1. Start from clean, fetched `origin/main` on `feature/live-e2e-validation` without deleting an
   existing branch or user changes.
2. Run `npm test`, `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm run build`, and
   `git diff --check`.
3. Discover the current Claude executable. Check `--version`, `--help`, `auth status`, and support
   for print/stream-json/verbose/plan/no-prompts/schema/resume options.
4. Discover a complete current Codex Desktop runtime, excluding `.codex/.sandbox-bin`. Check
   `--version`, `exec --help`, workspace-write options, and sibling code-mode host, command runner,
   and Windows sandbox setup executables. Do not hardcode discovered user/hash paths in product code.
5. Create a user-owned throwaway repository with committed `package.json` and `README.md`, no
   dependencies, `npm test` = `node --test`, and a parent sentinel. Record clean status, HEAD, file
   list/hashes, sentinel hash, and product DB hash.
6. Dry-run the same Orchestrator/SQLite/collector/budget-decorator structure with scripted adapters.
   Verify the approve path completes, a request-changes path stops after one review without revise,
   all inputs use the throwaway root, and an attempted fourth call is rejected before its adapter.
7. Keep the harness ignored and all preflight DB/log data outside the product repository.

Any failed gate stops M13 before a model call.

## 2. Live scenario

Submit this bounded request through `Orchestrator`:

> Do not add external dependencies. Create `greet.js` and `greet.test.js`. `greet(name)` must return
> `Hello, <name>!`. Use `node:test` for a normal name and run `npm test`. Modify no other files.

### A. Claude plan start

- exactly one `start`, `kind=plan`, permission mode `plan`, prompt on stdin, throwaway cwd/root;
- valid plan, session and usage persisted; task reaches `awaiting_approval`;
- no Codex or review call yet.

### B. Approval and Codex implement start

Call `Orchestrator.approve()`. Before allowing review, the one-off guard must verify:

- exactly one Codex `start`, `kind=implement`, workspace-write and throwaway cwd/`-C`;
- valid implementation result/session/usage;
- only `greet.js` and `greet.test.js` changed, no dependency change, and `npm test` passes;
- sentinel and committed files remain unchanged.

If this guard fails, replace the implementation terminal with a failure so Orchestrator never starts
review.

### C. Claude review resume

- exactly one Claude `resume`, `kind=review`, with the exact stored plan session; never `--continue`;
- permission mode `plan`, prompt on stdin, bounded two-file diff present only in memory;
- schema-valid review, usage persisted, and one terminal per run with one preceding usage event;
- `approve` completes the task at review round 1; `request_changes` produces the bounded
  `REVIEW_ROUNDS_EXCEEDED` outcome without another call.

## 3. Persistence and safety acceptance

After the pipeline:

- record call order/count, safe argv shape, durations, normalized event order, terminal/result and
  usage for every run without logging session values;
- confirm plan and review run records share the Claude session and the Codex session is present;
- record state transitions, results, task/project usage aggregates, Git status and hashes;
- close and reopen the SQLite DB, then compare task, runs, reviews, messages, timeline and usage;
- scan persisted values for review-context markers and unified-diff content; both must be absent;
- verify the product DB/hash and product tree changed only through intentional M13 documentation or
  regression fixes;
- record any new Claude plan files by path/count without deleting them.

Do not add raw provider fixtures unless a new provider shape breaks an adapter. If that occurs, stop
without retry, sanitize only the failed stream, make the smallest offline regression fix, and mark
M13 partial.

## 4. Documentation, cleanup, and delivery

- Update `docs/STATUS.md`, `docs/ROADMAP.md`, and `docs/PROTOCOL.md` from observed facts, retaining
  M12 as completed history.
- Delete only the exact one-off harness and temporary log/preflight files created for M13. Leave the
  live throwaway repository and SQLite DB in place and report their paths.
- Confirm no harness, raw capture, DB, auth data, or prompt/diff body remains in the product tree.
- Run throwaway `npm test`, then the complete product suite and `git diff --check` again.
- Review the diff and secrets, create a Korean commit, push the feature branch, and open a Korean PR
  using the existing repository PR format. Report PR/merge/check state.

## 5. Completion criteria

- [ ] offline suite, CLI/runtime/auth checks, scripted dry-run, budget guard, and throwaway baseline pass
- [ ] at most the ordered three live calls; no retries or additional model calls
- [ ] production Orchestrator, SQLite, collector, adapters, parsers, prompts, state machine, and runner used
- [ ] exact Claude plan session reused for review
- [ ] task completes on first approval, or request-changes partial outcome stops after one review
- [ ] only two requested source/test files changed and their tests pass
- [ ] every run has one usage before one terminal; aggregates match persisted records
- [ ] close/reopen preserves all required entities and review prompt/diff are absent from storage
- [ ] sentinel, committed throwaway files, product DB, and product boundaries remain intact
- [ ] harness/log cleanup and full final verification pass
- [ ] Korean commit, push, and PR completed as explicitly requested

## 6. Observed result (2026-09-16)

M13 is **partial**. All offline gates passed, then the approved live sequence made one Claude plan
start and one Codex implement start. Claude produced a valid plan and Codex created exactly
`greet.js` / `greet.test.js`; an independent `npm test` passed. Codex reported that test through the
Windows Desktop host as `"<runtime>\\pwsh.exe" -Command 'npm test'`. The parser did not recognise the
wrapped form, so `testsPassed` was `null` and the one-off post-implementation guard converted the
completion to `run_failed(M13_POST_IMPLEMENT_GUARD)`. The required predecessor-success rule then
prevented Claude review resume. There was no retry or third model call.

The parser now recognises only the nested script after a PowerShell `-Command` boundary. A sanitized
fixture and parser/adapter tests cover the observed shape without retaining a real path, session,
prompt, or command output. The live loop was not rerun after this offline fix; completing Claude
resume and the full loop requires separate future authorization.
