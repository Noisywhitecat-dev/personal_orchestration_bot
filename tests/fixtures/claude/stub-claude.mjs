/* global process, Buffer, setTimeout */
// Stand-in for the `claude` binary in tests. Never calls a model, never spawns anything.
// Driven by env vars:
//   STUB_FIXTURE      .jsonl file streamed to stdout line by line
//   STUB_EXIT_CODE    exit code after streaming (default 0)
//   STUB_STDERR       text written to stderr
//   STUB_HANG_MS      keep the process alive this long after streaming (timeout/abort tests)
//   STUB_ECHO_FILE    if set, write JSON { argv, cwd, stdinBytes } to this file
//   STUB_REQUIRE_ARG  exit 64 unless this exact argv token is present
import { readFileSync, writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);

let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => (stdin += c));
await new Promise((r) => process.stdin.on('end', r));

if (process.env.STUB_ECHO_FILE) {
  writeFileSync(
    process.env.STUB_ECHO_FILE,
    JSON.stringify({ argv, cwd: process.cwd(), stdinBytes: Buffer.byteLength(stdin) }),
  );
}
if (process.env.STUB_REQUIRE_ARG && !argv.includes(process.env.STUB_REQUIRE_ARG)) {
  process.stderr.write('missing required arg ' + process.env.STUB_REQUIRE_ARG + '\n');
  process.exit(64);
}

if (process.env.STUB_FIXTURE) {
  for (const line of readFileSync(process.env.STUB_FIXTURE, 'utf8').split(/\r?\n/)) {
    process.stdout.write(line + '\n');
  }
}
if (process.env.STUB_STDERR) process.stderr.write(process.env.STUB_STDERR);

const hang = Number(process.env.STUB_HANG_MS ?? 0);
if (hang > 0) {
  process.on('SIGTERM', () => undefined); // force SIGKILL escalation
  await new Promise((r) => setTimeout(r, hang));
}
process.exit(Number(process.env.STUB_EXIT_CODE ?? 0));
