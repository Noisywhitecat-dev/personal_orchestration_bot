# CODEX_NEXT_TASK — M15 remaining live acceptance

M15's product implementation, automated suite, fake-adapter browser acceptance, cancellation,
timeout, and valid non-temporary out-of-root denial are complete. The local MVP must **not** be
called 100% complete until the remaining live acceptance below succeeds.

## Why this remains

Two real Claude Code 2.1.260 planning starts failed before producing a plan:

1. the first schema had a top-level `oneOf` without a top-level `type`;
2. after adding `type: "object"`, the provider rejected top-level `oneOf`/`allOf`/`anyOf`.

The implementation now sends a flat object schema with a required `kind` discriminator and lets the
strict zod union validate the selected plan/clarification branch. Offline regression tests pass, but
the fixed schema was not live-retried: the M15 authorization allowed no retries for this
non-transient implementation defect, and the two remaining calls cannot complete a three-call path.

## Exact remaining acceptance

Only after a new explicit user approval for at least three real calls:

1. Re-run all offline checks and a token-free current-runtime preflight.
2. Create a new clean throwaway Git repository and outside sentinel; never target this product repo.
3. In one process, use the production Orchestrator, SQLite repositories, adapters, parsers, process
   runner, and review-context collector for exactly:
   `Claude plan start -> Codex implement start -> exact Claude session review resume`.
4. Require terminal `completed`, exact-session reuse by boolean only, independent DB reopen equality,
   passing throwaway tests, unchanged sentinel/product repository, and no prompt/diff/session/raw
   output in persisted or committed files.
5. Record each child process exit code alongside duration, normalized event types, terminal result,
   and usage in the field-whitelisted observer. Do not infer child exit from the outer harness.
6. Do not retry a failed call. Delete the ignored one-off harness and any raw capture, preserve the
   throwaway, update M15 documentation to 100%, then run the full suite again.

## Current verified baseline

- Automated: 18 test files / 225 tests after the final M15 additions, plus typecheck, lint, format,
  build, and `git diff --check` (rerun before delivery; this count is updated from the final run).
- Browser: complete clarification-to-approval flow, restart/reload recovery, cancellation,
  run-budget failure UX, responsive layout, no console warnings/errors.
- Live calls used in M15: 6 of 8. Claude: four calls (two planning schema failures, one cancellation,
  one timeout). Codex: two permission scenarios; the valid non-temporary boundary attempt created no
  outside file. Two calls remain unused and are insufficient for the required three-call flow.
- M13 and M14 still establish the same provider stages cumulatively, but not in one uninterrupted
  process.

Do not implement packaging, cloud deployment, multi-user auth, new providers, or an emergency-repair
path as part of this acceptance task.
