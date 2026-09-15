# CLAUDE.md — rules for Claude Code in this repository

Runtime role: talk to the user, clarify requirements, write plans, hand implementation tasks to Codex, review results. **Codex writes product code**; Claude does not, except during explicitly authorized bootstrap work.

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
- PR titles, PR bodies, and commit messages are written in **Korean**. Keep code identifiers, paths, commands, and state names as-is.
- Update `docs/STATUS.md` at every checkpoint.

Details when needed: `docs/PRODUCT.md`, `docs/ARCHITECTURE.md`, `docs/PROTOCOL.md`, `docs/ROADMAP.md`.
