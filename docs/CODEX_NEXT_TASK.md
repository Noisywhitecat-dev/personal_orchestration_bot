# CODEX_NEXT_TASK — M11 User-supervised live Codex start/resume validation

> Supersedes the M6 task (build the Codex CLI adapter), which is complete. The adapter, parser and
> process runner already exist and pass stub tests. **M11 does not build anything new**: it checks
> the existing code against the real `codex` CLI and records what actually happens.

You are Codex, the default implementer from here on. Claude Code built M0–M10 at the user's explicit
request; that bootstrap phase is finished.

## 0. Hard limits

- **At most 2 real `codex exec` invocations**: one `start`, plus one `resume` only if the start
  succeeded. Both require an explicit user approval first (§3).
- **0 Claude invocations.** Do not run `claude`, and do not start the server with `CLAUDE_ADAPTER=cli`.
- **No automatic retry.** If a call fails for any reason, stop and report. A further call needs a new
  approval.
- Real runs happen **only in a throwaway repository**, never in this product repository.
- **No commit, push or PR.** No `reset`, `rebase`, `stash` or force checkout.
- Do not weaken a safety option to make a run succeed. If safe argv is incompatible with
  non-interactive execution, **that incompatibility is the result** — record it.

## 1. Read first

1. `AGENTS.md` — your rules in this repo.
2. `docs/STATUS.md` — "Current state" table (what is live-tested vs stub-tested) and the
   "Codex CLI adapter (session 2)" section (the argv and mapping assumptions you are verifying).
3. `src/infrastructure/agents/codex-cli-adapter.ts` — argv builders, forbidden-option guard, adapter.
4. `src/infrastructure/agents/codex-jsonl-parser.ts` — the mapping table in the file header is the
   hypothesis under test.
5. `src/infrastructure/process/process-runner.ts` — how child processes are spawned and bounded.
6. `tests/integration/codex-cli-adapter.test.ts` and `tests/fixtures/codex/` — the synthetic
   fixtures and the stub executable pattern.
7. `tests/fixtures/claude/live-plan-v2.1.260.jsonl` + the "sanitized live capture" tests in
   `src/infrastructure/agents/claude-jsonl-parser.test.ts` — the precedent for capturing and
   sanitizing a live run. **Do not modify anything Claude-side.**

Do not read the rest of the repository unless something above points at it.

## 2. Phase A — preflight (spends no tokens, no `codex exec`)

### A1. Git

```bash
git status --short --branch
git log -8 --oneline --decorate
git fetch origin && git log -1 --oneline origin/main
git diff --quiet HEAD origin/main   # expect identical content
```

If the working tree is clean and matches `origin/main`, create a branch:

```bash
git switch -c feature/live-codex-validation origin/main
```

If that branch already exists, inspect it — do not delete or overwrite it. If there are uncommitted
user changes, preserve them and report rather than working around them.

### A2. Baseline verification

```bash
npm test
npm run typecheck
npm run lint
npm run format:check
npm run build
```

All must pass **before** any live call. Expected baseline at handoff time: **15 test files,
186 tests**. If something already fails, investigate and report; do not proceed to a live call.

### A3. Codex CLI facts (read-only commands only)

Allowed: `codex --version`, `codex exec --help`, `codex exec resume --help`, checking whether a path
exists. Not allowed: `codex exec`, login, install, update.

Last known on this machine (verify, do not assume):

- version `codex-cli 0.154.0-alpha.6.2`
- executable `C:\Users\Study\.codex\.sandbox-bin\codex.exe` (not on `PATH`)
- `codex exec` supports `--json`, `-s/--sandbox`, `-C/--cd`, `--skip-git-repo-check`, `-c key=value`,
  prompt via trailing `-` (stdin)
- `codex exec resume` supports `--json`, `-c key=value`, `--skip-git-repo-check`, prompt via `-`,
  and **does not list `--sandbox` or `-C`**
- ⚠️ the user's `~/.codex/config.toml` sets `sandbox_mode = "danger-full-access"`, which is why the
  adapter pins the sandbox explicitly on both paths

Record what the installed version actually reports. If a flag the adapter passes is gone, stop and
report before calling.

### A4. Throwaway repository

Create a fresh temporary directory **outside** this repository, note its absolute path, and:

- `git init`
- set `user.name` / `user.email` **repository-locally only** (never `--global`)
- write a small `README.md` (no secrets, no real project content)
- optionally a trivial file to edit later
- one initial commit inside the throwaway repo only
- no `npm install`, no dependencies, no network

Put a **sentinel file** in the parent directory (e.g. `<parent>/SENTINEL.txt` with fixed content) so
you can prove afterwards that nothing outside the throwaway root was touched.

Record, before any live call:

- `git status --porcelain` (should be empty)
- the full file list
- SHA-256 of every file, including the sentinel

### A5. Capture location

```
data/live-captures/codex-start-<timestamp>.raw.jsonl
data/live-captures/codex-resume-<timestamp>.raw.jsonl
```

`data/live-captures/` is already in `.gitignore` — confirm with `git check-ignore -v`. Never print a
raw capture in full, never copy one into `tests/fixtures/` unsanitized.

A one-off harness is fine (and is how M10 was done): reuse `buildStartArgs` / `buildResumeArgs`,
`runProcess` and `CodexJsonlParser`, tee stdout to the capture file, keep the prompt on stdin, and
log only counts. Dry-run it against the existing stub (`tests/fixtures/codex/stub-codex.mjs`) first.
Prefer keeping such a harness untracked unless it is clearly worth shipping under `scripts/`.

### A6. Sanitization plan

Decide up front, before you hold real data, which fields survive. Use a **whitelist**, as
`live-plan-v2.1.260.jsonl` did: replace session ids and UUIDs with fixed test values, drop `cwd`,
absolute paths, machine details, env, timings and tool payloads, keep field names, nesting, ordering
and usage numbers.

## 3. Approval gate

After Phase A, report to the user and stop:

- Codex executable absolute path and version
- throwaway repository absolute path (+ sentinel path)
- the exact argv for start and for resume (prompt shown as "on stdin", not inlined)
- sandbox mode for both paths, and the child `cwd`
- planned call count: 1 start, then at most 1 resume
- raw capture paths
- confirmation that this product repository is never passed as `-C` or `cwd`
- baseline results from A2 and the CLI facts from A3
- that a failure will not be retried automatically

Then ask exactly one question, in the user's language:

> 실제 Codex start 1회와, 성공할 경우 같은 session을 resume하는 1회까지 최대 2회의 호출을 실행해도 될까요?

Do not run `codex exec` before an explicit yes. If the user approves only the start, run only the
start and ask again before resuming. If the user declines, finish the documentation part, mark M11
incomplete, and report.

## 4. Phase B — the start call

Prompt: keep it tiny and self-contained. Something like _create `hello.txt` in the repository root
containing one fixed greeting line, then verify it exists_. No product code, no dependencies, no
network, no staging or committing.

argv (adjust to what the installed CLI supports; the adapter builds this for you):

```
exec --json --sandbox workspace-write -C <canonical throwaway root> [--skip-git-repo-check] -
```

Required invariants:

- prompt on **stdin**, never in argv
- `shell: false`, argv array, via `runProcess`
- `cwd` = canonical throwaway root
- forbidden anywhere: `--dangerously-bypass-approvals-and-sandbox`, `--dangerously-bypass-hook-trust`,
  `--yolo`, `--full-auto`, `--sandbox danger-full-access`, `-a never`, `--ask-for-approval never`,
  `-c sandbox_mode=danger-full-access`
- a sensible timeout and an `AbortSignal`

Record: exit code, duration, stdout line count, stderr length (tail only), and the session id.

## 5. Phase B — the resume call (only if the start succeeded)

Use the **exact session id** from the start run.

```
exec resume --json -c sandbox_mode="workspace-write" [--skip-git-repo-check] <sessionId> -
```

Prompt: equally small, e.g. _change the greeting line in `hello.txt` to a different fixed sentence;
do not touch any other file_.

Verify:

- the same session is selected (no `--continue`, no "most recent" guessing)
- the CLI accepts the argv on this version
- `--json` still applies
- the sandbox override is honoured even though `~/.codex/config.toml` says `danger-full-access`
- the child `cwd` really determines the workspace (this version has no `-C` for `resume`)
- Codex remembers the first request's context
- changes stay inside the throwaway root

If `resume` ignores `cwd` and works somewhere else, **do not hide it** — record it as a limitation
and stop.

## 6. What to check in the real JSONL

For both runs:

- the thread/session start event name and the session id field
- agent message events, reasoning events (if any)
- command start / completion events and exit codes
- file-change events (or their absence — the adapter falls back to `git status --porcelain`)
- where usage appears, and the exact field names
- turn/thread completion event and its subtype
- error events, if any
- terminal ordering: exactly one terminal, usage emitted before it
- differences between start and resume output
- duplicate completions, non-JSON banner lines, unknown/malformed line counts

Then feed both captures through the current `CodexJsonlParser` and confirm:
`session_started`, `command_started`/`command_completed`, `usage_reported`, `run_completed` with
`kind: "implementation"`, one terminal, usage before it, no unknown-event explosion.

## 7. Usage checks

From the real usage event(s): input tokens, cached input tokens, output tokens, reasoning tokens,
total tokens, and which fields are simply absent. Confirm usage is recorded separately for the start
and the resume run, appears exactly once per run, and lands before the terminal event.

Never invent estimates and never convert a cost figure into tokens. If the real payload carries
something the current `UsageSnapshot` cannot express, **do not extend the domain now** — write it
down as a limitation.

## 8. Safety verification after the calls

Compare against the A4 baseline:

- `git status --porcelain` in the throwaway repo (changes expected, and only there)
- file list and SHA-256 of every file
- the sentinel file in the parent directory must be **unchanged**
- nothing in this product repository changed except your intended edits (`git status --short` here)

Do not execute anything Codex wrote. Do not stage or commit inside the throwaway repo.

If a write landed outside the throwaway root, treat it as a **safety finding**: stop, do not retry,
report it, and leave M11 incomplete.

## 9. Fixtures, tests and code changes

Sanitize the captures into:

```
tests/fixtures/codex/live-start-v<version>.jsonl
tests/fixtures/codex/live-resume-v<version>.jsonl
```

(sanitize the version for a filename, e.g. `0.154.0-alpha.6.2` → `0.154.0-alpha.6.2` is fine if the
characters are legal; otherwise simplify and say so in the test comment.)

Add regression tests next to the existing Codex parser tests covering: event mapping, exactly one
terminal, usage before terminal and its values, unknown/malformed counts, session id handling on
resume, and that the fixture contains no paths, no real session ids and no prompt text.

Change production code **only if the real format differs** from the current parser, and then only:

- `src/infrastructure/agents/codex-jsonl-parser.ts` and its tests
- `src/infrastructure/agents/codex-cli-adapter.ts` and its tests
- `tests/fixtures/codex/**`, `tests/integration/codex-cli-adapter.test.ts`
- the docs listed in §10

Do **not** touch: the Claude adapter/parser/fixtures, `src/domain/**` (state machine, task/run),
`src/application/**` (orchestrator, review context/prompt), persistence and migrations,
`src/server/**`, `src/web/**`, or the process runner beyond a narrowly justified fix.

Preserve the parser invariants: exactly one terminal event; exactly one `usage_reported` before it;
unknown value → `null`, never `0`; malformed lines never abort a run; no natural-language guessing of
results.

## 10. Documentation

- `docs/STATUS.md`: verified CLI version, the exact argv used for start and resume, the real event
  shapes, session id behaviour, usage mapping and real numbers, sandbox/cwd findings, the throwaway
  repo and sentinel result, any parser/adapter change, the fixtures added, the number of live calls,
  final verification results, and what is still unverified (at least: the live Claude review run and
  the full loop with both real CLIs).
- `docs/ROADMAP.md`: mark M11 with its real outcome (done / partially verified / blocked).
- `docs/PROTOCOL.md`: only if the observed event mapping differs from what is documented — record
  observations, not guesses.
- Update the "Current state" verification table in `docs/STATUS.md`.

Do not restate a past session's results as if they happened in yours.

## 11. Cleanup

After the fixtures and tests are in place, delete **exactly** the raw capture files you created:
resolve each path, confirm it is inside `data/live-captures/`, confirm the filename matches what you
recorded, then delete it. No wildcards, no recursive directory deletion. Afterwards confirm
`git status --short` shows no raw capture.

Leave the throwaway repository in place and report its path unless the user asks you to remove it.

## 12. Final verification

```bash
npm test
npm run typecheck
npm run lint
npm run format:check
npm run build
```

The test suite must remain fully offline — it must never invoke the real `codex` binary.

## 13. Completion criteria

- [ ] user approval obtained before any live call
- [ ] at most 1 real `codex exec` start, and at most 1 `resume` (only after a successful start)
- [ ] 0 Claude invocations
- [ ] all live runs confined to the throwaway repository; sentinel unchanged
- [ ] `workspace-write` sandbox on both paths; no forbidden option used
- [ ] prompts delivered on stdin
- [ ] real JSONL shapes recorded for start and resume
- [ ] session id captured and reused correctly on resume
- [ ] cwd / root boundary behaviour recorded
- [ ] real usage recorded for both runs
- [ ] sanitized fixtures added
- [ ] parser regression tests added
- [ ] raw captures deleted by exact path
- [ ] `npm test` / `typecheck` / `lint` / `format:check` / `build` all pass
- [ ] `docs/STATUS.md` and `docs/ROADMAP.md` updated to the real outcome
- [ ] nothing committed or pushed

If the user does not approve the live calls, M11 is **not** complete: report the preflight results
and stop.

## 14. Known risks

- `exec resume` has no `--sandbox` / `-C` on the last known version; the adapter compensates with
  `-c sandbox_mode="workspace-write"` and the child `cwd`. Whether the config override actually wins
  over the user's `danger-full-access` config, and whether `cwd` really sets the workspace, is
  exactly what M11 must establish.
- The parser's event names (`thread.started`, `item.*`, `turn.completed`, …) come from documentation,
  not from observed output. Expect to adjust the mapping table in the parser header.
- Non-interactive approval behaviour is unknown. If the CLI blocks waiting for approval, the run will
  hit the timeout and surface as `TIMEOUT`; report that rather than disabling approvals.
- Claude's live run left a plan document in `~/.claude/plans/`. Codex may similarly write outside the
  workspace (e.g. session files under `~/.codex/`); check and record it rather than assuming.
