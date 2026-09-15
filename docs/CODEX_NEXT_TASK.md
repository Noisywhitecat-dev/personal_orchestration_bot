# CODEX_NEXT_TASK — local MVP complete

M0–M15 and the personal local MVP are complete. There is no active required implementation or
validation task.

## Final acceptance evidence

- Automated: 18 test files / 226 tests, plus typecheck, lint, format, build, and `git diff --check`.
- Browser: clarification, restart/reload, approval, completed flow, cancellation, budget failure,
  usage/runtime status, responsive layout, and empty console warnings/errors.
- Live: a fresh SQLite v3 throwaway completed exactly
  `Claude plan start -> Codex implement start -> exact Claude session review resume`.
- All three provider child processes exited 0, the task completed, review round 1 approved, and the
  same Claude session was resumed.
- The fresh DB reopened identically and contained no command stdout/stderr tails, diff, review
  context marker, raw provider event, private runtime path, or credential. Its physical byte scan
  was also clean before any post-run repair.
- The throwaway contained only the expected untracked `greet.js` and `greet.test.js`; its committed
  files, HEAD, outside sentinel, and the product repository were unchanged.

## Future work

Create a new bounded task before changing the product. Optional candidates remain packaging,
explicitly gated emergency repair, cloud deployment, multi-user authentication, mobile/voice, and
additional providers. A real Claude or Codex invocation always requires a new explicit user-approved
call count and must target a throwaway rather than this repository.
