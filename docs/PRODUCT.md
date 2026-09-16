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
3. Claude returns either one concise clarification question or a structured plan.
4. A clarification answer resumes the **same Claude session**; bounded rounds may repeat until a plan is ready.
5. The user reviews the plan, task run limits, run-boundary token ceilings, and maximum possible follow-up calls, then approves or rejects.
6. On approval Codex implements; events stream to the timeline.
7. Task moves to `review_requested`; Claude reviews using the same planning session.
8. Approve → `completed`. Change requested → recorded and sent back to the **same** Codex session.
9. Clarification, review, Claude-run, and Codex-run bounds fail safely before an unauthorized next provider call.
10. Every run records token usage (actual / estimated / unavailable). A token ceiling blocks only at the next run boundary and cannot hard-stop one provider call.
11. State survives browser refresh and server restart; interrupted active runs become `INTERRUPTED` rather than silently resuming.

## UI (minimal)

- A standalone Windows desktop shell that starts and stops the local server automatically
- In-app fake/real adapter settings and native project/executable pickers
- Project registration and selection
- Chat-style request, Claude clarification, and user answer history
- Plan approval/rejection with persisted execution limits and maximum remaining calls
- Current state, implement/revise/review rounds, cancel, failure code, and next action
- Task/project usage with actual/estimated/unavailable confidence and token-ceiling status
- Token-free runtime status with paths, credentials, prompts, diffs, and session ids omitted
- Responsive single-column fallback for narrow screens

Flow verification takes priority over visual polish.

## Usage accounting

Per provider (claude / codex), per project / task / run / session: input, cached input, output, reasoning, total tokens, plus `source: actual | estimated | unavailable`. Unknown values are `null`, never `0`. Session ids remain server-side and are exposed publicly only as presence booleans.

## Explicit non-goals (current phase)

Unattended CLI execution (every real run is user-approved), sandbox bypass, auto commit/push, GitHub API, multi-user auth, cloud, Docker, plugin systems, other model providers, agent teams, parallel implementation, worktree automation, voice, mobile, cost conversion, quota lookup, auto-update, telemetry.
