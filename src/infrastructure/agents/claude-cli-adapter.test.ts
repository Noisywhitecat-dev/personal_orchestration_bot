import { describe, expect, it } from 'vitest';

import { OrchestrationError } from '../../domain/errors.js';
import {
  FORBIDDEN_CLAUDE_ARGS,
  FORBIDDEN_PERMISSION_MODES,
  assertNoForbiddenClaudeArgs,
  assertValidClaudeSessionId,
  buildClaudeResumeArgs,
  buildClaudeStartArgs,
} from './claude-cli-adapter.js';
import { PLAN_JSON_SCHEMA, REVIEW_JSON_SCHEMA } from './claude-jsonl-parser.js';

const PROMPT = 'SECRET PROMPT TEXT that must never appear in argv';

function flagValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

describe('buildClaudeStartArgs', () => {
  it('pins print/stream-json/verbose/plan/no-prompts/schema, no max-turns unless configured', () => {
    const args = buildClaudeStartArgs({ kind: 'plan' });
    expect(args).toEqual([
      '--print',
      '--output-format',
      'stream-json',
      '--verbose',
      '--permission-mode',
      'plan',
      '--permission-prompts',
      'none',
      '--json-schema',
      JSON.stringify(PLAN_JSON_SCHEMA),
    ]);
    expect(args).not.toContain('--max-turns');
    expect(args).not.toContain('--resume');
  });

  it('review kind uses the review schema; max-turns and model are appended when set', () => {
    const args = buildClaudeStartArgs({
      kind: 'review',
      maxTurns: 6,
      model: 'sonnet',
      effort: 'high',
    });
    expect(flagValue(args, '--json-schema')).toBe(JSON.stringify(REVIEW_JSON_SCHEMA));
    expect(flagValue(args, '--max-turns')).toBe('6');
    expect(flagValue(args, '--model')).toBe('sonnet');
    expect(flagValue(args, '--effort')).toBe('high');
  });

  it('rejects non-positive or non-integer maxTurns and odd model names', () => {
    expect(() => buildClaudeStartArgs({ kind: 'plan', maxTurns: 0 })).toThrow(OrchestrationError);
    expect(() => buildClaudeStartArgs({ kind: 'plan', maxTurns: 1.5 })).toThrow(OrchestrationError);
    expect(() =>
      buildClaudeStartArgs({ kind: 'plan', model: '--dangerously-skip-permissions' }),
    ).toThrow(OrchestrationError);
  });

  it('never contains the prompt (prompt goes to stdin)', () => {
    const args = buildClaudeStartArgs({ kind: 'plan' });
    expect(args.join(' ')).not.toContain(PROMPT);
    expect(args.some((a) => a.includes('SECRET'))).toBe(false);
  });
});

describe('buildClaudeResumeArgs', () => {
  it('adds --resume <id> with the same read-only policy and schema', () => {
    const args = buildClaudeResumeArgs({
      kind: 'review',
      sessionId: 'a1b2c3d4-e5f6-7890-abcd-ef0123456789',
    });
    expect(flagValue(args, '--resume')).toBe('a1b2c3d4-e5f6-7890-abcd-ef0123456789');
    expect(flagValue(args, '--permission-mode')).toBe('plan');
    expect(flagValue(args, '--permission-prompts')).toBe('none');
    expect(flagValue(args, '--json-schema')).toBe(JSON.stringify(REVIEW_JSON_SCHEMA));
    expect(args).not.toContain('--continue');
    expect(args).not.toContain('-c');
  });

  it('rejects malformed session ids (options, spaces, empty, too long)', () => {
    for (const bad of ['--continue', '-c', '', 'a b', 'x'.repeat(200), '../etc', 'id;rm']) {
      expect(() => buildClaudeResumeArgs({ kind: 'plan', sessionId: bad }), bad).toThrow(
        OrchestrationError,
      );
      expect(() => assertValidClaudeSessionId(bad), bad).toThrow(OrchestrationError);
    }
    expect(() => assertValidClaudeSessionId('sess-plan-0001')).not.toThrow();
  });
});

describe('forbidden Claude options', () => {
  it('built argv never contains a forbidden option or a non-plan permission mode', () => {
    const all = [
      ...buildClaudeStartArgs({ kind: 'plan', maxTurns: 3 }),
      ...buildClaudeResumeArgs({ kind: 'review', sessionId: 's1', maxTurns: 3 }),
    ];
    for (const f of FORBIDDEN_CLAUDE_ARGS) expect(all).not.toContain(f);
    for (const m of FORBIDDEN_PERMISSION_MODES) {
      expect(all).not.toContain(m);
      expect(all).not.toContain(`--permission-mode=${m}`);
    }
    const modes = all.filter((_, i) => all[i - 1] === '--permission-mode');
    expect(modes).toEqual(['plan', 'plan']);
  });

  it('assertNoForbiddenClaudeArgs catches every forbidden form', () => {
    const base = ['--print', '--permission-mode', 'plan'];
    const bad: string[][] = [
      [...base, '--dangerously-skip-permissions'],
      [...base, '--allow-dangerously-skip-permissions'],
      [...base, '--continue'],
      [...base, '-c'],
      ['--print', '--permission-mode', 'acceptEdits'],
      ['--print', '--permission-mode', 'bypassPermissions'],
      ['--print', '--permission-mode', 'auto'],
      ['--print', '--permission-mode', 'dontAsk'],
      ['--print', '--permission-mode=acceptEdits'],
      ['--print', '--permission-mode'], // missing value
      ['--print'], // no permission mode at all
    ];
    for (const args of bad)
      expect(() => assertNoForbiddenClaudeArgs(args), args.join(' ')).toThrow();
    expect(() => assertNoForbiddenClaudeArgs(base)).not.toThrow();
  });
});
