import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { AgentEvent } from '../../domain/agent-events.js';
import { asRunId } from '../../domain/ids.js';
import { CodexJsonlParser } from './codex-jsonl-parser.js';

const FIXTURES = join(process.cwd(), 'tests', 'fixtures', 'codex');

function parseFixture(
  name: string,
  exit = { exitCode: 0, outcome: 'exited', stderrTail: '' },
): { events: AgentEvent[]; parser: CodexJsonlParser } {
  const parser = new CodexJsonlParser(asRunId('run-1'), () => '2026-01-01T00:00:00.000Z');
  const events: AgentEvent[] = [];
  for (const line of readFileSync(join(FIXTURES, name), 'utf8').split(/\r?\n/)) {
    events.push(...parser.parseLine(line));
  }
  events.push(...parser.finish(exit));
  return { events, parser };
}

const types = (events: AgentEvent[]) => events.map((e) => e.type);
const terminals = (events: AgentEvent[]) =>
  events.filter((e) => e.type === 'run_completed' || e.type === 'run_failed');
const completion = (events: AgentEvent[]) => {
  const e = events.find((x) => x.type === 'run_completed');
  if (!e || e.type !== 'run_completed' || e.result.kind !== 'implementation') {
    throw new Error('no implementation result');
  }
  return e.result;
};
const usage = (events: AgentEvent[]) => {
  const e = events.find((x) => x.type === 'usage_reported');
  if (!e || e.type !== 'usage_reported') throw new Error('no usage');
  return e.usage;
};

describe('CodexJsonlParser', () => {
  it('happy path: event order, usage, implementation result', () => {
    const { events, parser } = parseFixture('happy-path.jsonl');
    expect(types(events)).toEqual([
      'session_started',
      'reasoning_delta',
      'message_delta',
      'command_started',
      'command_completed',
      'message_delta',
      'usage_reported',
      'run_completed',
    ]);
    expect(parser.state.sessionId).toBe('thread-abc-123');
    expect(usage(events)).toEqual({
      inputTokens: 1200,
      cachedInputTokens: 400,
      outputTokens: 350,
      reasoningTokens: 120,
      totalTokens: 1550,
      source: 'actual',
    });
    const result = completion(events);
    expect(result.summary).toBe('Added the logout button and a test; npm test passes.');
    expect(result.changedFiles).toEqual(['src/header.tsx', 'src/header.test.tsx']);
    expect(result.testsPassed).toBe(true);
    expect(terminals(events)).toHaveLength(1);
  });

  it('command string form and failed test command → testsPassed false, tails preserved', () => {
    const { events } = parseFixture('command-failed.jsonl');
    const cmd = events.find((e) => e.type === 'command_completed');
    expect(cmd?.type === 'command_completed' && cmd.exitCode).toBe(1);
    expect(cmd?.type === 'command_completed' && cmd.stderrTail).toContain('expected 1 to be 2');
    const started = events.find((e) => e.type === 'command_started');
    expect(started?.type === 'command_started' && started.command).toEqual(['npm', 'test']);
    expect(completion(events).testsPassed).toBe(false);
    // Missing fields stay null, never 0.
    expect(usage(events).cachedInputTokens).toBeNull();
    expect(usage(events).reasoningTokens).toBeNull();
  });

  it('no usage → exactly one unavailable usage before completion', () => {
    const { events } = parseFixture('no-usage.jsonl');
    const usages = events.filter((e) => e.type === 'usage_reported');
    expect(usages).toHaveLength(1);
    expect(usage(events).source).toBe('unavailable');
    expect(usage(events).totalTokens).toBeNull();
    expect(completion(events).testsPassed).toBeNull();
    expect(completion(events).changedFiles).toEqual([]);
  });

  it('provider error → run_failed, later lines ignored, usage unavailable', () => {
    const { events } = parseFixture('error.jsonl');
    const term = terminals(events);
    expect(term).toHaveLength(1);
    expect(term[0]?.type).toBe('run_failed');
    expect(term[0]?.type === 'run_failed' && term[0].error.message).toBe('Rate limit exceeded');
    expect(events.filter((e) => e.type === 'message_delta')).toHaveLength(1);
    expect(usage(events).source).toBe('unavailable');
  });

  it('banner, malformed JSON and unknown events do not abort the run', () => {
    const { events, parser } = parseFixture('garbage.jsonl');
    expect(parser.state.sessionId).toBe('thread-garbage');
    expect(parser.state.malformedCount).toBe(1); // "{not valid json" ("[1,2,3]" is skipped as non-object text)
    expect(parser.state.unknownCount).toBe(2); // some.future.event, web_search item
    expect(completion(events).summary).toBe('Survived the noise.');
    expect(usage(events).totalTokens).toBe(15);
    expect(terminals(events)).toHaveLength(1);
  });

  it('duplicate completion: only the first terminal event is emitted', () => {
    const { events } = parseFixture('duplicate-completion.jsonl');
    expect(terminals(events)).toHaveLength(1);
    expect(completion(events).summary).toBe('First completion.');
    expect(usage(events).totalTokens).toBe(15);
    expect(events.filter((e) => e.type === 'usage_reported')).toHaveLength(1);
  });

  it('large output: command tails and summary are bounded', () => {
    const { events } = parseFixture('large-output.jsonl');
    const cmd = events.find((e) => e.type === 'command_completed');
    if (cmd?.type !== 'command_completed') throw new Error('no command');
    expect(cmd.stdoutTail?.length).toBe(2000);
    expect(cmd.stdoutTail?.endsWith('END-OUT')).toBe(true);
    expect(cmd.stderrTail?.endsWith('END-ERR')).toBe(true);
    expect(completion(events).summary.length).toBe(2000);
  });

  it('resume fixture reports the same session id', () => {
    const { parser, events } = parseFixture('resume.jsonl');
    expect(parser.state.sessionId).toBe('thread-abc-123');
    expect(completion(events).changedFiles).toEqual(['src/header.tsx']);
  });

  it('process ended without completion → run_failed with exit info', () => {
    const parser = new CodexJsonlParser(asRunId('r'), () => 't');
    parser.parseLine('{"type":"thread.started","thread_id":"x"}');
    const out = parser.finish({ exitCode: 2, outcome: 'exited', stderrTail: 'boom' });
    expect(types(out)).toEqual(['usage_reported', 'run_failed']);
    const failed = out[1];
    expect(failed?.type === 'run_failed' && failed.error.code).toBe('CODEX_EXITED_WITHOUT_RESULT');
    expect(failed?.type === 'run_failed' && failed.error.message).toContain('boom');
  });

  it('timeout / abort outcomes map to TIMEOUT / CANCELLED', () => {
    const t = new CodexJsonlParser(asRunId('r'), () => 't').finish({
      exitCode: null,
      outcome: 'timeout',
      stderrTail: '',
    });
    expect(t[1]?.type === 'run_failed' && t[1].error.code).toBe('TIMEOUT');
    const a = new CodexJsonlParser(asRunId('r'), () => 't').finish({
      exitCode: null,
      outcome: 'aborted',
      stderrTail: '',
    });
    expect(a[1]?.type === 'run_failed' && a[1].error.code).toBe('CANCELLED');
  });

  it('nothing is emitted after a terminal event', () => {
    const parser = new CodexJsonlParser(asRunId('r'), () => 't');
    parser.parseLine('{"type":"turn.completed"}');
    expect(parser.parseLine('{"type":"thread.started","thread_id":"late"}')).toEqual([]);
    expect(parser.parseLine('{"type":"error","message":"late"}')).toEqual([]);
    expect(parser.state.sessionId).toBeNull();
  });
});
