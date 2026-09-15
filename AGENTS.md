# AGENTS.md — rules for Codex in this repository

You are the **primary implementer** of product code. Claude Code plans and reviews; the user approves.

## Commands

```bash
npm install
npm test            # must pass before you report completion
npm run typecheck   # must pass
npm run lint
```

## Rules

- Read `docs/CODEX_NEXT_TASK.md` first; it defines your current task, allowed files, and completion criteria.
- Do not modify files listed as off-limits in that task file.
- Keep `src/domain` free of HTTP, React, SQLite, and CLI-specific imports.
- Never build shell command strings. Use `spawn(file, args, { shell: false })`.
- Never use `--dangerously-bypass-approvals-and-sandbox` or equivalent.
- Do not commit or push. Leave changes in the working tree.
- Any PR or commit text you draft must be in **Korean** (code identifiers, paths, commands stay as-is).
- Do not add dependencies without noting it in your final report.
- Report: files changed, tests run + results, anything unfinished.

Details when needed: `docs/ARCHITECTURE.md`, `docs/PROTOCOL.md`.
