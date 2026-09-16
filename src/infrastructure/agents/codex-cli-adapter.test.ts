import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { OrchestrationError } from '../../domain/errors.js';
import { FixedClock } from '../../domain/ports.js';
import {
  FORBIDDEN_CODEX_ARGS,
  FORBIDDEN_CODEX_PAIRS,
  REQUIRED_WINDOWS_CODEX_RUNTIME_FILES,
  CodexCliAdapter,
  assertCompleteLocalCodexRuntime,
  assertNoForbiddenArgs,
  buildResumeArgs,
  buildStartArgs,
  normalizeCodexChangedFiles,
} from './codex-cli-adapter.js';

const ROOT = 'D:\\proj\\demo';
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('buildStartArgs', () => {
  it('produces the verified argv shape with prompt on stdin', () => {
    expect(buildStartArgs({ projectRoot: ROOT })).toEqual([
      'exec',
      '--json',
      '--sandbox',
      'workspace-write',
      '-C',
      ROOT,
      '-',
    ]);
  });

  it('adds --skip-git-repo-check only when requested', () => {
    expect(buildStartArgs({ projectRoot: ROOT, skipGitRepoCheck: true })).toContain(
      '--skip-git-repo-check',
    );
    expect(buildStartArgs({ projectRoot: ROOT })).not.toContain('--skip-git-repo-check');
  });

  it('adds an explicit model and reasoning effort only when configured', () => {
    const args = buildStartArgs({
      projectRoot: ROOT,
      model: 'gpt-5.6-sol',
      reasoningEffort: 'medium',
    });
    expect(args).toContain('--model');
    expect(args).toContain('gpt-5.6-sol');
    expect(args).toContain('model_reasoning_effort="medium"');
    expect(buildStartArgs({ projectRoot: ROOT }).join(' ')).not.toContain('model_reasoning_effort');
  });
});

describe('buildResumeArgs', () => {
  it('uses resume with a -c sandbox override, no --sandbox/-C', () => {
    const args = buildResumeArgs({ sessionId: 'thread-abc-123' });
    expect(args).toEqual([
      'exec',
      'resume',
      '--json',
      '-c',
      'sandbox_mode="workspace-write"',
      'thread-abc-123',
      '-',
    ]);
    expect(args).not.toContain('--sandbox');
    expect(args).not.toContain('-C');
  });

  it('rejects session ids that look like options or contain odd characters', () => {
    expect(() => buildResumeArgs({ sessionId: '--last' })).toThrow(OrchestrationError);
    expect(() => buildResumeArgs({ sessionId: 'a b' })).toThrow(OrchestrationError);
    expect(() => buildResumeArgs({ sessionId: '' })).toThrow(OrchestrationError);
  });

  it('keeps model and effort overrides when resuming the exact session', () => {
    const args = buildResumeArgs({
      sessionId: 'thread-abc-123',
      model: 'gpt-5.6-sol',
      reasoningEffort: 'high',
    });
    expect(args).toContain('gpt-5.6-sol');
    expect(args).toContain('model_reasoning_effort="high"');
  });
});

describe('forbidden options', () => {
  it('never appear in built argv', () => {
    const all = [
      ...buildStartArgs({ projectRoot: ROOT, skipGitRepoCheck: true }),
      ...buildResumeArgs({ sessionId: 's1', skipGitRepoCheck: true }),
    ];
    for (const f of FORBIDDEN_CODEX_ARGS) expect(all).not.toContain(f);
    for (const [flag, value] of FORBIDDEN_CODEX_PAIRS) {
      expect(all).not.toContain(`${flag}=${value}`);
      const i = all.indexOf(flag);
      if (i >= 0) expect(all[i + 1]).not.toBe(value);
    }
    expect(all.join(' ')).not.toContain('danger-full-access');
    expect(all.join(' ')).not.toContain('never');
  });

  it('assertNoForbiddenArgs catches every forbidden form', () => {
    const bad: string[][] = [
      ['exec', '--dangerously-bypass-approvals-and-sandbox'],
      ['exec', '--dangerously-bypass-hook-trust'],
      ['exec', '--yolo'],
      ['exec', '--full-auto'],
      ['exec', '--sandbox', 'danger-full-access'],
      ['exec', '--sandbox=danger-full-access'],
      ['exec', '-s', 'danger-full-access'],
      ['exec', '-a', 'never'],
      ['exec', '--ask-for-approval', 'never'],
      ['exec', '-c', 'sandbox_mode="danger-full-access"'],
      ['exec', '-c', 'sandbox_mode=danger-full-access'],
    ];
    for (const args of bad) expect(() => assertNoForbiddenArgs(args), args.join(' ')).toThrow();
    expect(() => assertNoForbiddenArgs(buildStartArgs({ projectRoot: ROOT }))).not.toThrow();
  });
});

describe('explicit local Codex runtime preflight', () => {
  function runtimeDirectory(): string {
    const directory = mkdtempSync(join(tmpdir(), 'codex-runtime-'));
    temporaryDirectories.push(directory);
    return directory;
  }

  it('accepts a complete Windows runtime beside an explicit codex.exe', () => {
    const directory = runtimeDirectory();
    for (const file of REQUIRED_WINDOWS_CODEX_RUNTIME_FILES) {
      writeFileSync(join(directory, file), 'fixture');
    }
    expect(() =>
      assertCompleteLocalCodexRuntime(join(directory, 'codex.exe'), 'win32'),
    ).not.toThrow();
  });

  it('rejects an incomplete explicit codex.exe before an adapter can run', () => {
    const directory = runtimeDirectory();
    const executable = join(directory, 'codex.exe');
    writeFileSync(executable, 'fixture');

    let message = '';
    try {
      assertCompleteLocalCodexRuntime(executable, 'win32');
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain(executable);
    for (const component of REQUIRED_WINDOWS_CODEX_RUNTIME_FILES.slice(1)) {
      expect(message).toContain(component);
    }
    if (process.platform === 'win32') {
      expect(() => new CodexCliAdapter({ executable, clock: new FixedClock() })).toThrowError(
        /Incomplete Codex runtime/,
      );
    }
  });

  it('does not impose private-runtime layout on PATH names or non-Codex wrappers', () => {
    expect(() => assertCompleteLocalCodexRuntime('codex', 'win32')).not.toThrow();
    expect(() => assertCompleteLocalCodexRuntime(process.execPath, 'win32')).not.toThrow();
  });
});

describe('normalizeCodexChangedFiles', () => {
  it('makes in-root absolute paths relative and rejects outside paths', () => {
    expect(
      normalizeCodexChangedFiles(
        [join(ROOT, 'hello.txt'), 'nested\\file.ts', join(ROOT, 'hello.txt'), 'D:\\outside.txt'],
        ROOT,
      ),
    ).toEqual(['hello.txt', 'nested/file.ts']);
  });
});
