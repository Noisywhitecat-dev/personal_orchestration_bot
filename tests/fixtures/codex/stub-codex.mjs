/* global process, Buffer, setTimeout */
// Stand-in for the `codex` binary in tests. Never spawns anything.
// Behaviour is driven by env vars so tests can select a fixture:
//   STUB_FIXTURE      path to a .jsonl file streamed to stdout line by line
//   STUB_EXIT_CODE    exit code after streaming (default 0)
//   STUB_STDERR       text written to stderr before exiting
//   STUB_HANG_MS      keep the process alive this long after streaming (timeout/abort tests)
//   STUB_ECHO_ARGS    if set, write argv (JSON) to stderr as the first line
//   STUB_ECHO_STDIN   if set, write stdin length to stderr as `stdin-bytes=<n>`
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
if (process.env.STUB_ECHO_ARGS) process.stderr.write(`argv=${JSON.stringify(args)}\n`);

let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => (stdin += c));
await new Promise((r) => process.stdin.on('end', r));
if (process.env.STUB_ECHO_STDIN) process.stderr.write(`stdin-bytes=${Buffer.byteLength(stdin)}\n`);

const fixture = process.env.STUB_FIXTURE;
if (fixture) {
  const lines = readFileSync(fixture, 'utf8').split(/\r?\n/);
  for (const line of lines) process.stdout.write(line + '\n');
}
if (process.env.STUB_STDERR) process.stderr.write(process.env.STUB_STDERR);

const hang = Number(process.env.STUB_HANG_MS ?? 0);
if (hang > 0) {
  // Ignore SIGTERM so the runner has to escalate; proves SIGKILL / taskkill path.
  process.on('SIGTERM', () => undefined);
  await new Promise((r) => setTimeout(r, hang));
}
process.exit(Number(process.env.STUB_EXIT_CODE ?? 0));
