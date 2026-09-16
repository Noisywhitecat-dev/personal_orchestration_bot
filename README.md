# personal_orchestration_bot

A personal, local-first orchestration program that lets **Claude Code** and **Codex** collaborate on a single local development project.

- The user talks to **Claude** through one chat UI.
- Claude clarifies requirements, writes a plan, and asks the user to approve it.
- Once approved, **Codex** implements the plan in the registered project directory.
- Claude reviews the diff / test results and either approves or sends a bounded number of change requests back to the same Codex session.
- Every Claude/Codex run records token usage, clearly separating **actual** values (from the CLI) from **estimated** or **unavailable** ones.
- Workflow state transitions are enforced by code (a deterministic state machine), not by AI judgment.

## Status

The personal local MVP is complete. It includes multi-round clarification, task-level run/token budgets, restart-safe persistence, runtime diagnostics, and the responsive web UI. Deterministic fake adapters remain the default; real CLIs are opt-in. Automated and browser acceptance pass. A fresh SQLite v3 run also completed the uninterrupted real Claude plan → Codex implement → exact-session Claude review flow, with all three child exit codes captured and no command output or diff retained in storage; see [docs/STATUS.md](docs/STATUS.md).

## Quick start

### Windows desktop app

The desktop edition starts the server, SQLite database, and UI together. No terminal is needed after
the portable executable has been built or downloaded.

```bash
npm install
npm run desktop:dist
```

Run `app-release/AI Orchestrator-0.1.0-x64.exe`. The first launch uses safe fake adapters. Open **앱
설정** inside the left sidebar to select real Claude Code / Codex executables; saving restarts the
app automatically. Use **폴더 선택** to register a project without typing its path. Desktop data is
kept in the operating system's per-user application-data directory, not beside the executable.

For a developer launch without packaging:

```bash
npm run desktop
```

See [docs/DESKTOP.md](docs/DESKTOP.md) for the non-technical setup guide.

### Browser development mode

```bash
npm install
npm test          # unit + integration tests (no real CLI needed)
npm run dev       # server on :3080, web UI on :5173
```

## Adapters

Both AI adapters default to **fake** so the whole flow runs without any CLI. Real CLIs are opt-in via environment variables (see `.env.example`):

| Variable                                                            | Values                   | Notes                                                                                                                                                                                                                             |
| ------------------------------------------------------------------- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CLAUDE_ADAPTER`                                                    | `fake` (default) / `cli` | `cli` runs the local Claude Code CLI using your existing login. Planning and review always run with `--permission-mode plan` (read-only); the prompt is passed on stdin.                                                          |
| `CLAUDE_EXECUTABLE`                                                 | path or name             | default `claude`. The desktop app is an MSIX package: from an ordinary shell use `%LOCALAPPDATA%\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\Claude\claude-code\<version>\claude.exe`. Log in once with `claude auth login`. |
| `CLAUDE_TIMEOUT_MS`                                                 | positive integer         | default 600000                                                                                                                                                                                                                    |
| `CLAUDE_MAX_TURNS`                                                  | positive integer         | passed as `--max-turns` only when set (not listed by `claude 2.1.260 --help`)                                                                                                                                                     |
| `CODEX_ADAPTER`                                                     | `fake` (default) / `cli` | `cli` runs `codex exec` with `--sandbox workspace-write`                                                                                                                                                                          |
| `CODEX_EXECUTABLE`, `CODEX_TIMEOUT_MS`, `CODEX_SKIP_GIT_REPO_CHECK` |                          | see `.env.example`                                                                                                                                                                                                                |

Task defaults are controlled by `MAX_CLAUDE_RUNS`, `MAX_CODEX_RUNS`, `MAX_CLARIFICATION_ROUNDS`, `MAX_REVIEW_ROUNDS`, and optional `CLAUDE_TOKEN_CEILING` / `CODEX_TOKEN_CEILING`. A token ceiling is checked before each run; it is a **run-boundary ceiling**, not a provider-side hard cap, so one call can cross it.

No API keys are read from `.env`.

Validation scope so far:

| Path                                | Status                                                                                                                                                                                                                                               |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude `plan` start                 | **live-validated** on Claude Code 2.1.260                                                                                                                                                                                                            |
| Claude `review` start               | **live-validated** with a bounded diff in M12                                                                                                                                                                                                        |
| Claude `review --resume`            | **live-validated** in M14 with the exact stored M13 plan session                                                                                                                                                                                     |
| Codex start / resume                | **live-validated** on codex-cli 0.154.0-alpha.6.2; an incomplete explicitly selected Windows runtime fails before invocation                                                                                                                         |
| Bounded review diff                 | **live-validated** in M12 and through the M14 continuation; prompt/diff remain memory-only                                                                                                                                                           |
| Full plan → implement → review loop | **complete** — deterministic fake/browser loops pass, and a fresh v3 real three-call flow completed with exact Claude session reuse, review approval, three child exit codes of 0, DB reopen equality, and no persisted command tail or diff marker. |

M15 also live-validated cancellation, timeout, and a Codex `workspace-write` attempt against a non-temporary sibling directory. The attempted outside file was absent and both sentinels and repositories remained unchanged. An earlier `%TEMP%` target was intentionally discarded as invalid evidence because the runtime permits writes there.

Each live Claude planning run also writes its own plan document under `~/.claude/plans/`.

### Review diff

After every Codex implement/revise run the server collects a **read-only, bounded git diff** of the project working tree (tracked changes against `HEAD` plus untracked text files) and embeds it in the Claude review prompt as untrusted data. `REVIEW_DIFF_MAX_BYTES` (default 65536) caps it. The diff exists only inside that one prompt: it is never written to SQLite, the timeline, SSE or logs. `.git/`, `node_modules/`, `dist/`, `.env*` (except `.env.example`), key/credential files and binaries are excluded (paths only). The snapshot is the current working tree, so pre-existing local edits may be mixed in with Codex's changes; nothing is staged, stashed or reset.

## Documents

| File                                               | Purpose                                          |
| -------------------------------------------------- | ------------------------------------------------ |
| [docs/PRODUCT.md](docs/PRODUCT.md)                 | What the product is and is not                   |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)       | Layers, directories, key design decisions        |
| [docs/PROTOCOL.md](docs/PROTOCOL.md)               | Task state machine, agent events, usage model    |
| [docs/ROADMAP.md](docs/ROADMAP.md)                 | Milestones                                       |
| [docs/STATUS.md](docs/STATUS.md)                   | Current progress, verification log, known issues |
| [docs/CODEX_NEXT_TASK.md](docs/CODEX_NEXT_TASK.md) | Completion handoff and future-task boundary      |
| [AGENTS.md](AGENTS.md)                             | Rules for Codex when working in this repo        |
| [CLAUDE.md](CLAUDE.md)                             | Rules for Claude Code when working in this repo  |

## Optional post-MVP candidates

Multi-user auth, cloud deployment, plugin marketplaces, additional model providers, automatic git commit/push, and a separately gated Claude emergency-repair path.
