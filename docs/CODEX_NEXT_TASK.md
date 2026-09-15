# CODEX_NEXT_TASK — M15 final post-fix live acceptance

M15's product implementation, automated suite, browser acceptance, safety probes, and one
uninterrupted real `plan -> implement -> review -> completed` flow are complete. The local MVP must
**not** be called 100% complete until the post-fix acceptance below succeeds.

## Why this remains

The successful three-call flow revealed that `command_completed.stdoutTail` could persist a Codex
`git diff` in SQLite. Migration v3 removes legacy stdout/stderr tails, compacts the database with
secure deletion, and stores only exit/presence metadata for new command events. Offline migration,
physical-byte, and public-DTO regression tests pass.

The same live harness also failed to retain each provider child process's OS exit code. The task
completed and all normalized terminal events were successful, but an outer process exit cannot be
used as evidence for an individual child. A fresh run is required to verify both fixes together.

## Exact remaining acceptance

Only after a new explicit user approval for exactly three real calls:

1. Re-run all offline checks and a token-free current-runtime preflight.
2. Create a new clean throwaway Git repository and outside sentinel; never target this product repo.
3. Before any model call, dry-run the ignored harness with stubs and prove it records the child exit
   code for every adapter invocation.
4. In one process, use the production Orchestrator, SQLite repositories, adapters, parsers, process
   runner, and review-context collector for exactly:
   `Claude plan start -> Codex implement start -> exact Claude session review resume`.
5. Require terminal `completed`, exact-session reuse by boolean only, three captured child exit codes,
   independent DB reopen equality, passing throwaway tests, and unchanged sentinel/product repo.
6. Inspect the fresh v3 DB before any repair. It must contain no stdout/stderr tail keys, command
   output, provider prompt, diff, raw provider output, private runtime path, or credential. Session
   ids may exist only in their intended private task/run columns, never in timeline or public DTOs.
7. Do not retry a failed call. Delete the ignored one-off harness and any raw capture, preserve the
   throwaway, update M15 documentation to 100% only on success, then run the full suite again.

## Current verified baseline

- Automated: 18 test files / 226 tests, plus typecheck, lint, format, build, and `git diff --check`.
- Browser: complete clarification-to-approval flow, restart/reload recovery, cancellation,
  run-budget failure UX, responsive layout, and no console warnings/errors.
- Live: nine calls across two explicit authorizations. Calls 7–9 completed one uninterrupted flat-
  schema flow; exact Claude session reuse, two expected files, tests, Git scope, persistence reopen,
  and review approval all passed.
- The exact successful DB was migrated to v3. Logical and physical scans of DB/WAL/SHM then found no
  command tails or diff marker, without changing its completed task, three runs, or 29 events.

Do not repeat cancellation, timeout, permission probes, packaging, cloud deployment, multi-user
auth, new providers, or an emergency-repair path as part of this acceptance task.
