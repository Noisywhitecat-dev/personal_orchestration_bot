# Roadmap

| Milestone | Scope                                                                            | Status |
| --------- | -------------------------------------------------------------------------------- | ------ |
| M0        | Repo contract: configs, docs, AGENTS.md, CLAUDE.md                               | Done   |
| M1        | Domain types, state machine, usage model, agent events, unit tests               | Done   |
| M2        | AgentAdapter, FakeClaude/FakeCodex, Orchestrator, review loop, integration tests | Done   |
| M3        | SQLite persistence, repositories, restart recovery test, HTTP API, SSE           | Done   |
| M4        | Minimal React UI                                                                 | Done   |
| M5        | `docs/CODEX_NEXT_TASK.md` for the real Codex CLI adapter                         | Done   |

## After bootstrap

1. Real Codex CLI adapter (JSONL parsing, resume, usage, timeout, sandbox policy) — by Codex.
2. Real Claude Code adapter.
3. Git diff capture for review input.
4. Emergency-repair path for Claude (explicitly gated).
5. Electron/Tauri packaging.
