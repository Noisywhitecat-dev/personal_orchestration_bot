# Roadmap

| Milestone | Scope                                                                                                    | Status                                                                                                     |
| --------- | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| M0        | Repo contract: configs, docs, AGENTS.md, CLAUDE.md                                                       | Done                                                                                                       |
| M1        | Domain types, state machine, usage model, agent events, unit tests                                       | Done                                                                                                       |
| M2        | AgentAdapter, FakeClaude/FakeCodex, Orchestrator, review loop, integration tests                         | Done                                                                                                       |
| M3        | SQLite persistence, repositories, restart recovery test, HTTP API, SSE                                   | Done                                                                                                       |
| M4        | Minimal React UI                                                                                         | Done                                                                                                       |
| M5        | `docs/CODEX_NEXT_TASK.md` for the real Codex CLI adapter                                                 | Done                                                                                                       |
| M6        | Real Codex CLI adapter (implemented; stub-tested, live validation pending in M11)                        | Done                                                                                                       |
| M7        | Asynchronous planning: 202 + draft, background planner, draft cancel/recovery                            | Done                                                                                                       |
| M8        | Real Claude Code CLI adapter (plan/review, permission-mode plan, structured output)                      | Done (live-validated for `plan` start in M10; review/resume stub-only)                                     |
| M9        | Git diff capture for review input (bounded, read-only, memory-only; temp-git-repo + fake-adapter tested) | Done                                                                                                       |
| M10       | Minimal live Claude planning validation (user-supervised)                                                | Done — verified on claude 2.1.260: plan-mode stream-json, structured_output, real usage, project untouched |

## After the Claude-led bootstrap

M0–M10 are complete. The default implementer from here on is **Codex**; Claude stays planner/reviewer and can still be asked to plan, review, document or implement a specific piece on request.

### Next validation

| Milestone | Scope                                                                                                                        | Document                  |
| --------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| M11       | User-supervised live Codex start + resume validation (at most 2 real `codex exec` calls, throwaway repo, sanitized fixtures) | `docs/CODEX_NEXT_TASK.md` |

### Later validation

- Live Claude **review** run (needs a real implementation to review; exercises the review schema and the bounded diff inside a real prompt).
- Live end-to-end loop: plan → approve → implement → review → complete with both real CLIs.

### Future candidates (not scheduled)

- Explicitly gated emergency-repair path for Claude.
- Electron/Tauri packaging.
