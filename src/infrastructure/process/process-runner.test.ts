import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { OrchestrationError } from '../../domain/errors.js';
import { assertInsideProjectRoot, runProcess, trackedChildCount } from './process-runner.js';

// All tests spawn `node -e` (process.execPath); never a real CLI.

let root: string;
let outside: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'runner-root-'));
  mkdirSync(join(root, 'sub'));
  outside = mkdtempSync(join(tmpdir(), 'runner-outside-'));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

function nodeScript(script: string, extra: Partial<Parameters<typeof runProcess>[0]> = {}) {
  return runProcess({
    file: process.execPath,
    args: ['-e', script],
    cwd: root,
    projectRoot: root,
    timeoutMs: 5_000,
    killGraceMs: 50,
    ...extra,
  });
}

describe('assertInsideProjectRoot', () => {
  it('accepts the root itself and subdirectories', () => {
    expect(assertInsideProjectRoot(root, root).cwd).toBeTruthy();
    expect(assertInsideProjectRoot(join(root, 'sub'), root).cwd).toContain('sub');
  });

  it('rejects a cwd outside the project root', () => {
    expect(() => assertInsideProjectRoot(outside, root)).toThrow(OrchestrationError);
    try {
      assertInsideProjectRoot(outside, root);
    } catch (err) {
      expect((err as OrchestrationError).code).toBe('INVALID_PROJECT_ROOT');
    }
  });

  it('rejects traversal that resolves outside', () => {
    expect(() => assertInsideProjectRoot(join(root, 'sub', '..', '..'), root)).toThrow(
      OrchestrationError,
    );
  });

  it('rejects a sibling directory whose name merely starts with the root name', () => {
    const sibling = root + '-sibling';
    mkdirSync(sibling);
    try {
      expect(() => assertInsideProjectRoot(sibling, root)).toThrow(OrchestrationError);
    } finally {
      rmSync(sibling, { recursive: true, force: true });
    }
  });

  it('rejects non-existent paths', () => {
    expect(() => assertInsideProjectRoot(join(root, 'nope'), root)).toThrow(OrchestrationError);
  });
});

describe('runProcess', () => {
  it('refuses to spawn when cwd is outside the root', () => {
    expect(() =>
      runProcess({
        file: process.execPath,
        args: ['-v'],
        cwd: outside,
        projectRoot: root,
        timeoutMs: 1000,
      }),
    ).toThrow(OrchestrationError);
  });

  it('separates stdout and stderr and preserves the exit code', async () => {
    const p = nodeScript(
      'process.stdout.write("out-1\\nout-2\\n"); process.stderr.write("err-1\\n"); process.exit(3);',
    );
    const lines: string[] = [];
    for await (const l of p.stdoutLines()) lines.push(l);
    const r = await p.done;
    expect(lines).toEqual(['out-1', 'out-2']);
    expect(r.stdoutTail).toBe('out-1\nout-2\n');
    expect(r.stderrTail).toBe('err-1\n');
    expect(r.exitCode).toBe(3);
    expect(r.outcome).toBe('exited');
    expect(r.stdoutTruncated).toBe(false);
  });

  it('passes stdin to the child', async () => {
    const p = nodeScript(
      'let s="";process.stdin.setEncoding("utf8");process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>{process.stdout.write("len="+s.length)});',
      { stdin: 'hello prompt' },
    );
    const r = await p.done;
    expect(r.stdoutTail).toBe('len=12');
  });

  it('does not inherit arbitrary parent env; forwards the allowlist', async () => {
    process.env['ORCH_SECRET_TEST'] = 'leak';
    try {
      const p = nodeScript(
        'process.stdout.write(JSON.stringify({s:process.env.ORCH_SECRET_TEST??null,a:process.env.ORCH_ALLOWED??null,p:typeof process.env.PATH}))',
        { env: { ORCH_ALLOWED: 'yes' } },
      );
      const r = await p.done;
      expect(JSON.parse(r.stdoutTail)).toEqual({ s: null, a: 'yes', p: 'string' });
    } finally {
      delete process.env['ORCH_SECRET_TEST'];
    }
  });

  it('bounds output and marks truncation, keeping the tail', async () => {
    const p = nodeScript(
      'process.stdout.write("A".repeat(5000)+"TAIL"); process.stderr.write("B".repeat(5000));',
      { maxOutputBytes: 1000 },
    );
    const r = await p.done;
    expect(r.stdoutTruncated).toBe(true);
    expect(r.stderrTruncated).toBe(true);
    expect(r.stdoutTail.length).toBe(1000);
    expect(r.stdoutTail.endsWith('TAIL')).toBe(true);
    expect(r.stderrTail.length).toBe(1000);
  });

  it('kills the child on timeout', async () => {
    const p = nodeScript('setInterval(()=>{},1000);', { timeoutMs: 100 });
    const r = await p.done;
    expect(r.outcome).toBe('timeout');
    expect(r.exitCode).not.toBe(0);
    expect(trackedChildCount()).toBe(0);
  });

  it('kills the child on abort', async () => {
    const controller = new AbortController();
    const p = nodeScript('setInterval(()=>{},1000);', {
      signal: controller.signal,
      timeoutMs: 5_000,
    });
    setTimeout(() => controller.abort(), 30);
    const r = await p.done;
    expect(r.outcome).toBe('aborted');
    expect(trackedChildCount()).toBe(0);
  });

  it('escalates to SIGKILL when the child ignores SIGTERM', async () => {
    const p = nodeScript('process.on("SIGTERM",()=>{}); setInterval(()=>{},1000);', {
      timeoutMs: 50,
      killGraceMs: 50,
    });
    const r = await p.done;
    expect(r.outcome).toBe('timeout');
    expect(r.exitCode === null || r.exitCode !== 0).toBe(true);
  });

  it('reports spawn errors instead of throwing', async () => {
    const p = runProcess({
      file: join(root, 'definitely-not-an-executable'),
      args: [],
      cwd: root,
      projectRoot: root,
      timeoutMs: 1000,
    });
    const r = await p.done;
    expect(r.outcome).toBe('spawn_error');
    expect(r.spawnError).toBeTruthy();
  });

  it('logs only a summary line (no argv contents, no stdin)', async () => {
    const logs: string[] = [];
    const p = nodeScript('process.stdout.write("SECRET-OUTPUT")', {
      stdin: 'SECRET-PROMPT',
      log: (l) => logs.push(l),
    });
    await p.done;
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('argc=2');
    expect(logs[0]).toContain('exit=0');
    expect(logs[0]).not.toContain('SECRET');
  });
});
