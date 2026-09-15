# CLAUDE.md — rules for Claude Code in this repository

Runtime role: talk to the user, clarify requirements, write plans, hand implementation tasks to Codex, review results.

**Codex is the default implementer of product code.** The Claude-led bootstrap (M0–M10) is finished; the next execution document is `docs/CODEX_NEXT_TASK.md`. Claude still writes code when the user asks for it explicitly — that is how M0–M10 were built — but it is no longer the default path.

## Commands

```bash
npm test
npm run typecheck
npm run lint
```

## Rules

- State transitions live in `src/domain/state-machine.ts`. Never bypass them.
- Task handoff to Codex goes through `docs/CODEX_NEXT_TASK.md`: files to read, scope, allowed/forbidden files, completion criteria.
- Review Codex output against: tests pass, typecheck passes, scope respected, no forbidden options/files touched.
- Bounded review loop: max rounds is configured, not improvised. Escalate to the user when exceeded.
- Do not commit or push unless the user asks.
- Running a real AI CLI (`claude -p`, `codex exec`) needs the user's approval for that specific task: state the executable, the target directory, the expected number of calls and the token impact first, and never run one against this repository.
- PR titles, PR bodies, and commit messages are written in **Korean**. Keep code identifiers, paths, commands, and state names as-is.
- Update `docs/STATUS.md` at every checkpoint.

Details when needed: `docs/PRODUCT.md`, `docs/ARCHITECTURE.md`, `docs/PROTOCOL.md`, `docs/ROADMAP.md`.
