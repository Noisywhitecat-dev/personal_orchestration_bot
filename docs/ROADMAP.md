# Roadmap

| Milestone | Scope                                                                                                    | Status                                                                                                     |
| --------- | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| M0        | Repo contract: configs, docs, AGENTS.md, CLAUDE.md                                                       | Done                                                                                                       |
| M1        | Domain types, state machine, usage model, agent events, unit tests                                       | Done                                                                                                       |
| M2        | AgentAdapter, FakeClaude/FakeCodex, Orchestrator, review loop, integration tests                         | Done                                                                                                       |
| M3        | SQLite persistence, repositories, restart recovery test, HTTP API, SSE                                   | Done                                                                                                       |
| M4        | Minimal React UI                                                                                         | Done                                                                                                       |
| M5        | `docs/CODEX_NEXT_TASK.md` for the real Codex CLI adapter                                                 | Done                                                                                                       |
| M6        | Real Codex CLI adapter                                                                                   | Done (live start/resume validated in M11)                                                                  |
| M7        | Asynchronous planning: 202 + draft, background planner, draft cancel/recovery                            | Done                                                                                                       |
| M8        | Real Claude Code CLI adapter (plan/review, permission-mode plan, structured output)                      | Done (live `plan` start in M10 and live `review` start in M12; resume remains stub-only)                   |
| M9        | Git diff capture for review input (bounded, read-only, memory-only; temp-git-repo + fake-adapter tested) | Done                                                                                                       |
| M10       | Minimal live Claude planning validation (user-supervised)                                                | Done — verified on claude 2.1.260: plan-mode stream-json, structured_output, real usage, project untouched |

## After the Claude-led bootstrap

M0–M10 are complete. The default implementer from here on is **Codex**; Claude stays planner/reviewer and can still be asked to plan, review, document or implement a specific piece on request.

### Validation milestones

| Milestone | Scope                                                                                     | Status                                                                                                                                                                 |
| --------- | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M11       | User-supervised live Codex start + resume validation (throwaway repo, sanitized fixtures) | Done — incomplete explicit Windows runtime fails fast; complete Desktop runtime verified with successful start and exact-session resume on codex-cli 0.154.0-alpha.6.2 |
| M12       | User-supervised live Claude review validation with a bounded deliberate defect            | Done — one review start on Claude Code 2.1.260 returned schema-valid `request_changes`; workspace and sentinel remained unchanged                                      |

### Later validation

- Live end-to-end loop: plan → approve → implement → review → complete with both real CLIs.
- Live Claude resume and cancellation/timeout/permission-denial behaviour.

### Future candidates (not scheduled)

- Explicitly gated emergency-repair path for Claude.
- Electron/Tauri packaging.
