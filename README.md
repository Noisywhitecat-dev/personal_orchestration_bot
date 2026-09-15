# personal_orchestration_bot

A personal, local-first orchestration program that lets **Claude Code** and **Codex** collaborate on a single local development project.

- The user talks to **Claude** through one chat UI.
- Claude clarifies requirements, writes a plan, and asks the user to approve it.
- Once approved, **Codex** implements the plan in the registered project directory.
- Claude reviews the diff / test results and either approves or sends a bounded number of change requests back to the same Codex session.
- Every Claude/Codex run records token usage, clearly separating **actual** values (from the CLI) from **estimated** or **unavailable** ones.
- Workflow state transitions are enforced by code (a deterministic state machine), not by AI judgment.

## Status

Bootstrap phase. Real Claude / Codex CLI adapters are **not** wired yet; the full flow runs against deterministic fake adapters. See [docs/STATUS.md](docs/STATUS.md).

## Quick start

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

No API keys are read from `.env`. The Claude adapter has been validated against one real planning run (claude 2.1.260): plan mode left the project untouched and returned a schema-valid plan. The Codex adapter is still stub-tested only. Note that each live Claude planning run also writes its own plan document under `~/.claude/plans/`.

### Review diff

After every Codex implement/revise run the server collects a **read-only, bounded git diff** of the project working tree (tracked changes against `HEAD` plus untracked text files) and embeds it in the Claude review prompt as untrusted data. `REVIEW_DIFF_MAX_BYTES` (default 65536) caps it. The diff exists only inside that one prompt: it is never written to SQLite, the timeline, SSE or logs. `.git/`, `node_modules/`, `dist/`, `.env*` (except `.env.example`), key/credential files and binaries are excluded (paths only). The snapshot is the current working tree, so pre-existing local edits may be mixed in with Codex's changes; nothing is staged, stashed or reset.

## Documents

| File                                               | Purpose                                           |
| -------------------------------------------------- | ------------------------------------------------- |
| [docs/PRODUCT.md](docs/PRODUCT.md)                 | What the product is and is not                    |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)       | Layers, directories, key design decisions         |
| [docs/PROTOCOL.md](docs/PROTOCOL.md)               | Task state machine, agent events, usage model     |
| [docs/ROADMAP.md](docs/ROADMAP.md)                 | Milestones                                        |
| [docs/STATUS.md](docs/STATUS.md)                   | Current progress, verification log, known issues  |
| [docs/CODEX_NEXT_TASK.md](docs/CODEX_NEXT_TASK.md) | Next task spec for Codex (real Codex CLI adapter) |
| [AGENTS.md](AGENTS.md)                             | Rules for Codex when working in this repo         |
| [CLAUDE.md](CLAUDE.md)                             | Rules for Claude Code when working in this repo   |

## Non-goals (for now)

Multi-user auth, cloud deployment, Electron/Tauri packaging, plugin marketplaces, additional model providers, automatic git commit/push.
