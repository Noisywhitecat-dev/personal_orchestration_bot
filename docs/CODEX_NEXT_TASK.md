# CODEX_NEXT_TASK — desktop local MVP complete

M0–M16 and the personal local MVP are complete. The Windows desktop shell, native settings/pickers,
embedded loopback server, per-user SQLite storage, and portable executable are implemented. There is no active required implementation or
validation task.

## Desktop acceptance evidence

- `npm run desktop` opened the app with Electron 44.4.1 and its embedded Node 24 runtime.
- The server selected a free port bound only to `127.0.0.1`; `/api/runtime-status` returned the
  expected fake-adapter defaults.
- The main window remained responsive and used the per-user application-data database.
- `npm run desktop:dist` produced one portable Windows x64 executable, which launched with the same
  window, fake adapters and loopback-only server.
- The renderer has no Node integration; its sandboxed, context-isolated preload exposes only the
  six bounded desktop operations.
- Renderer controls, state/usage/timeline labels, window title, dialogs, and the native application
  menu are displayed in Korean without changing stored protocol identifiers.
- Saving desktop settings restarts only the embedded server and reconnects the existing window;
  model and effort overrides are optional and are preserved across exact-session resumes.

## Final acceptance evidence

- Automated: 22 test files / 241 tests, plus typecheck, lint, format, build, and `git diff --check`.
- Desktop settings smoke: clicking save changed the embedded loopback port in place, reloaded the
  same renderer, and returned the persisted settings without a model call.
- Model UI smoke: Sonnet exposed only `low/medium/high/max`, GPT-5.5 exposed only
  `low/medium/high/xhigh`, both recommendation notes were visible, and the compatible selections
  survived the in-place restart without a provider call.
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

Create a new bounded task before changing the product. Optional candidates remain an explicitly
gated emergency repair, cloud deployment, multi-user authentication, mobile/voice, and
additional providers. A real Claude or Codex invocation always requires a new explicit user-approved
call count and must target a throwaway rather than this repository.
