# CODEX_NEXT_TASK — M12 user-supervised live Claude review validation

> M11 is complete. M12 validates the existing Claude `review` start path against one real,
> deliberately defective, bounded Git diff. It does not add a new orchestration feature.

## 0. Hard limits

- Exactly **one** real Claude Code `review` start is authorized by the M12 task prompt, and only
  after every preflight and offline check passes.
- **No retry, no Claude resume, no Codex or other model call.** If the one start fails or returns a
  structured error, stop and report it.
- Run the model only in a fresh throwaway Git repository, never in this product repository.
- Use the production `GitReviewContextCollector`, `buildReviewPrompt`, `ClaudeCliAdapter`,
  `ClaudeJsonlParser`, and adapter-owned `runProcess` path. Do not hand-build the Claude argv.
- Keep the prompt on stdin. Keep `--permission-mode plan` and `--permission-prompts none`; never use
  a bypass, automatic approval, or unrestricted permission option.
- No dependency additions, commit, push, PR, reset, rebase, stash, or destructive checkout.

## 1. Read first

1. `AGENTS.md`
2. `docs/STATUS.md`, `docs/ROADMAP.md`, and `docs/PROTOCOL.md`
3. `src/infrastructure/git/git-review-context-collector.ts`
4. `src/application/review-prompt.ts` and `src/application/review-context.ts`
5. `src/infrastructure/agents/claude-cli-adapter.ts`
6. `src/infrastructure/agents/claude-jsonl-parser.ts`
7. the related unit/integration tests and `tests/fixtures/claude/`

Preserve all M11 parser/runtime-preflight behavior and fixtures.

## 2. Offline preflight

Before a live invocation:

1. Confirm the working tree contains only the intended M12 changes.
2. Run `npm test`, `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm run build`, and
   `git diff --check`.
3. Locate the current Claude executable without assuming the M10 path. Record its absolute path.
4. Run only token-free CLI checks: `--version`, `--help`, and `auth status`. Confirm the production
   argv flags remain supported and authentication is usable. Do not install, update, or log in.
5. Create a fresh throwaway Git repository outside the product repository. Commit a correct
   `calculator.js` whose `add(a, b)` returns `a + b`, then leave an uncommitted defect changing it to
   `a - b`.
6. Put a fixed sentinel file in the throwaway repository's parent. Record the committed and working
   file hashes, `HEAD`, file list, and `git status --porcelain`.
7. Collect review context scoped to `calculator.js`. In memory, verify that the bounded diff contains
   the expected removed addition and added subtraction, contains no other file, and includes the
   begin/end markers. Do not print the prompt or full diff.
8. Build the prompt from a minimal task, plan, implementation report, and the real collected context.
9. Dry-run the same one-off harness through the checked-in Claude stub and parser. The stub run must
   not invoke the real executable.
10. Confirm raw captures and the harness are ignored or otherwise untracked, and establish an exact
    cleanup list before the live call.

If the executable moved, version changed from the last observation, authentication is unavailable,
a required flag disappeared, the throwaway baseline is wrong, or any offline check fails, do not
invoke the model. Report the exact blocking condition.

## 3. One live review start

Use `ClaudeCliAdapter.start({ kind: "review", ... })` in the one-off harness. The adapter must supply
the production review argv, JSON schema, stdin prompt, canonical throwaway `cwd`, environment
allowlist, timeout, and abort signal. A tee wrapper may transparently copy stdout for validation, but
must forward the exact adapter-produced argv and stdin with `spawn(file, args, { shell: false })`.

Record without exposing prompt text or sensitive raw fields:

- executable and version;
- argv with prompt represented as `stdin` and schema content summarized;
- start count, start/end time, duration, exit code, session id, stdout JSONL line count, and safe
  stderr length/tail;
- raw JSONL event kinds and normalized event order;
- usage field names and values;
- parser malformed/unknown counts and terminal ordering;
- returned `ReviewResult` and schema-validation result.

Stop immediately after a process failure, structured error item, parser failure, missing session id,
or invalid terminal ordering. Never retry.

## 4. Acceptance and safety checks

Full success requires all of the following:

- a non-empty session id and genuine stream-json output;
- `ReviewResultSchema` accepts the result;
- exactly one `usage_reported`, before exactly one `run_completed` terminal;
- `verdict: "request_changes"`;
- at least one concrete change request identifies that `add` must perform addition rather than
  subtraction;
- no file content or Git state changes in the throwaway repository;
- the sentinel, product repository, and any files outside the throwaway root remain unchanged.

If the schema is valid but the model misses the deliberate defect, do not retry: record M12 as
partially verified. Record any new `~/.claude/plans/` entry as a side effect, but do not delete it.
Never execute, stage, or commit anything produced by the live review.

## 5. Fixture and regression tests

Sanitize the raw stream with a strict whitelist. Replace session ids and UUIDs with stable test
values; remove paths, cwd, machine/account data, prompt text, timings, environment values, and tool
payloads. Preserve only the event fields, nesting, order, structured review result, and usage fields
needed to test the parser.

Add a versioned fixture under `tests/fixtures/claude/` and parser/adapter regression tests covering:

- live event mapping and session-id extraction;
- exactly one usage event before one terminal event;
- observed usage values and null handling for absent values;
- `run_completed` with a schema-valid review result;
- `request_changes` and the concrete addition/subtraction finding;
- malformed/unknown counts;
- absence of real ids, paths, prompt text, and other sensitive raw values.

Change production parsing only if the observed stream differs. Keep malformed lines non-fatal,
unknown numeric values as `null`, structured error handling intact, and terminal emission singular.

## 6. Documentation and cleanup

- Update `docs/STATUS.md` with observed executable/version/argv, event and usage mapping, review
  result, safety checks, call count, fixture/tests, verification results, and remaining gaps.
- Update `docs/ROADMAP.md` with the actual M12 outcome.
- Update `docs/PROTOCOL.md` only when the observed protocol adds or corrects durable facts.
- Correct stale M11 references while preserving clearly historical statements.
- Resolve and verify every raw capture and one-off harness path, then delete those exact files only.
  Do not use wildcards or recursive deletion.
- Leave the throwaway repository in place and report its absolute path.

## 7. Final verification

Run the complete offline suite again:

```bash
npm test
npm run typecheck
npm run lint
npm run format:check
npm run build
git diff --check
```

The checked-in tests must remain fully offline and must never invoke a real AI executable.

## 8. Completion criteria

- [ ] all offline and CLI preflight checks passed before the live invocation
- [ ] exactly one Claude review start; zero retries, resumes, Codex, or other model calls
- [ ] production review context, prompt builder, adapter, parser, and process runner used
- [ ] bounded prompt contained only the intended `calculator.js` diff
- [ ] real review result and usage parsed with one usage before one terminal
- [ ] deliberate subtraction defect detected, or a no-retry partial outcome documented
- [ ] throwaway files, Git state, sentinel, and product files remained within the expected boundaries
- [ ] sanitized live fixture and regression coverage added
- [ ] raw captures and one-off harnesses deleted by exact verified path
- [ ] complete final verification passed
- [ ] status, roadmap, and protocol agree with the actual observation
- [ ] no dependency, commit, push, or PR
