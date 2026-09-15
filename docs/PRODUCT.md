# Product

## One-line

A personal, local web application that orchestrates Claude Code (planner / reviewer) and Codex (implementer) on one local development project, with the user as the final approver.

## Who it is for

The author and a handful of acquaintances testing it from a personal GitHub repository. Not a hosted service.

## Roles at runtime

| Actor       | Responsibilities                                                                              |
| ----------- | --------------------------------------------------------------------------------------------- |
| User        | Registers projects, writes requests, approves/rejects plans, receives escalations             |
| Claude Code | Conversation, requirement clarification, plan writing, Codex task instructions, result review |
| Codex       | Implements approved tasks in the project directory, runs tests                                |
| Program     | Enforces state transitions, review-round limits, persistence, usage accounting                |

Claude does **not** edit product code at runtime. An emergency-repair path may be added later; it is out of MVP scope.

## MVP user flow

1. Register a local project (name + absolute root path).
2. Type a development request in the chat.
3. Claude returns a structured plan → task enters `awaiting_approval`.
4. User approves or rejects.
5. On approval Codex implements; events stream to the timeline.
6. Task moves to `review_requested`; Claude reviews.
7. Approve → `completed`. Change requested → recorded and sent back to the **same** Codex session.
8. Review loop is bounded by `maxReviewRounds`; exceeding it → `failed` with an escalation message.
9. Every run records token usage (actual / estimated / unavailable).
10. State survives browser refresh and server restart.

## UI (minimal)

- Left: registered projects
- Center: chat + execution timeline
- Right: current task state, approve/reject, run info, Claude/Codex usage
- Bottom: errors and system events

Flow verification takes priority over visual polish.

## Usage accounting

Per provider (claude / codex), per project / task / run / session: input, cached input, output, reasoning, total tokens, plus `source: actual | estimated | unavailable`. Unknown values are `null`, never `0`.

## Explicit non-goals (current phase)

Real CLI execution (bootstrap only), sandbox bypass, auto commit/push, GitHub API, multi-user auth, cloud, Docker, Electron/Tauri, plugin systems, other model providers, agent teams, parallel implementation, worktree automation, voice, mobile, cost conversion, quota lookup, auto-update, telemetry.
