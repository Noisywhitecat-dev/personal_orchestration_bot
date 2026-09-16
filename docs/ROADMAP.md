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
| M8        | Real Claude Code CLI adapter (plan/review, permission-mode plan, structured output)                      | Done (live plan start in M10, review start in M12, and exact-session review resume in M14)                 |
| M9        | Git diff capture for review input (bounded, read-only, memory-only; temp-git-repo + fake-adapter tested) | Done                                                                                                       |
| M10       | Minimal live Claude planning validation (user-supervised)                                                | Done — verified on claude 2.1.260: plan-mode stream-json, structured_output, real usage, project untouched |

## After the Claude-led bootstrap

M0–M10 are complete. The default implementer from here on is **Codex**; Claude stays planner/reviewer and can still be asked to plan, review, document or implement a specific piece on request.

### Validation milestones

| Milestone | Scope                                                                                              | Status                                                                                                                                                                                                                            |
| --------- | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M11       | User-supervised live Codex start + resume validation (throwaway repo, sanitized fixtures)          | Done — incomplete explicit Windows runtime fails fast; complete Desktop runtime verified with successful start and exact-session resume on codex-cli 0.154.0-alpha.6.2                                                            |
| M12       | User-supervised live Claude review validation with a bounded deliberate defect                     | Done — one review start on Claude Code 2.1.260 returned schema-valid `request_changes`; workspace and sentinel remained unchanged                                                                                                 |
| M13       | Real Orchestrator + SQLite loop across Claude plan, Codex implement and Claude resume              | Partial — live plan and implement succeeded, but a PowerShell-wrapped test command left `testsPassed=null`; guard blocked review, parser fixed offline, no retry                                                                  |
| M14       | Resume the M13 Claude plan session through a replay-backed continuation task                       | Done — one real review resume approved the bounded two-file diff and the separate M14 task completed; no plan/Codex call was repeated                                                                                             |
| M15       | Final local MVP: clarification, execution budgets, runtime status, completed UI, safety acceptance | **Done** — code/browser/offline paths pass. A fresh v3 real three-call flow completed with exact-session review approval, three child exit codes of 0, DB reopen equality, and no persisted/physical command tail or diff marker. |
| M16       | Standalone Windows desktop app, in-app adapter setup, portable executable                          | **Done** — Electron embeds the loopback server/UI/SQLite lifecycle; portable x64 EXE built and launched successfully.                                                                                                             |

### Local MVP completion

M0–M16 are complete. Further work requires a newly scoped post-MVP task and, when it involves a real
AI CLI, a separate explicit call budget.

### Optional post-MVP candidates

- Explicitly gated emergency-repair path for Claude.
- Cloud deployment, multi-user auth, mobile/voice, and additional model providers.
