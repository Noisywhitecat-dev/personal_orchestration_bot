import { describe, expect, it } from 'vitest';

import { OrchestrationError } from '../../domain/errors.js';
import {
  FORBIDDEN_CODEX_ARGS,
  FORBIDDEN_CODEX_PAIRS,
  assertNoForbiddenArgs,
  buildResumeArgs,
  buildStartArgs,
} from './codex-cli-adapter.js';

const ROOT = 'D:\\proj\\demo';

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
