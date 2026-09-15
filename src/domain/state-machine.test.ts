import { describe, expect, it } from 'vitest';

import { OrchestrationError } from './errors.js';
import { asProjectId, asTaskId } from './ids.js';
import {
  TRANSITIONS,
  assertTransition,
  canTransition,
  resolveReviewVerdict,
  transition,
} from './state-machine.js';
import {
  DEFAULT_MAX_REVIEW_ROUNDS,
  TASK_STATES,
  isTerminal,
  type Task,
  type TaskState,
} from './task.js';

function makeTask(state: TaskState, overrides: Partial<Task> = {}): Task {
  return {
    id: asTaskId('t-1'),
    projectId: asProjectId('p-1'),
    request: 'add a button',
    state,
    plan: null,
    reviewRound: 0,
    maxReviewRounds: DEFAULT_MAX_REVIEW_ROUNDS,
    reviews: [],
    codexSessionId: null,
    claudeSessionId: null,
    failure: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function expectCode(fn: () => void, code: string): void {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(OrchestrationError);
    expect((err as OrchestrationError).code).toBe(code);
    return;
  }
  throw new Error(`expected error ${code}`);
}

describe('TRANSITIONS table', () => {
  it('covers every state exactly once', () => {
    expect(Object.keys(TRANSITIONS).sort()).toEqual([...TASK_STATES].sort());
  });

  it('terminal states have no outgoing transitions', () => {
    for (const s of TASK_STATES) {
      if (isTerminal(s)) expect(TRANSITIONS[s]).toEqual([]);
    }
  });
});

describe('happy path', () => {
  it('walks the full approved flow', () => {
    const path: TaskState[] = [
      'awaiting_approval',
      'queued',
      'implementing',
      'review_requested',
      'reviewing',
      'approved',
      'completed',
    ];
    let task = makeTask('draft');
    for (const next of path) {
      task = transition(task, next, '2026-01-01T00:00:01.000Z', { userApproved: true });
      expect(task.state).toBe(next);
    }
  });

  it('supports the revision loop', () => {
    let task = makeTask('reviewing');
    task = transition(task, 'changes_requested', 'x');
    task = transition(task, 'implementing', 'x');
    task = transition(task, 'review_requested', 'x');
    expect(task.state).toBe('review_requested');
  });

  it('does not mutate the input task', () => {
    const original = makeTask('draft');
    const next = transition(original, 'awaiting_approval', '2026-02-02T00:00:00.000Z');
    expect(original.state).toBe('draft');
    expect(next.updatedAt).toBe('2026-02-02T00:00:00.000Z');
  });
});

describe('invalid transitions', () => {
  it('rejects skipping approval entirely', () => {
    expectCode(() => assertTransition('awaiting_approval', 'implementing'), 'INVALID_TRANSITION');
  });

  it('rejects draft -> completed', () => {
    expectCode(() => assertTransition('draft', 'completed'), 'INVALID_TRANSITION');
  });

  it('rejects any transition out of terminal states', () => {
    for (const from of ['completed', 'failed', 'cancelled'] as const) {
      for (const to of TASK_STATES) {
        expect(canTransition(from, to)).toBe(false);
      }
    }
  });

  it('rejects self transitions', () => {
    for (const s of TASK_STATES) expect(canTransition(s, s)).toBe(false);
  });
});

describe('approval gate', () => {
  it('blocks awaiting_approval -> queued without userApproved', () => {
    expectCode(() => assertTransition('awaiting_approval', 'queued'), 'APPROVAL_REQUIRED');
    expectCode(
      () => assertTransition('awaiting_approval', 'queued', { userApproved: false }),
      'APPROVAL_REQUIRED',
    );
  });

  it('allows it with userApproved: true', () => {
    expect(() =>
      assertTransition('awaiting_approval', 'queued', { userApproved: true }),
    ).not.toThrow();
  });

  it('allows rejection via cancelled without approval', () => {
    expect(() => assertTransition('awaiting_approval', 'cancelled')).not.toThrow();
  });
});

describe('resolveReviewVerdict', () => {
  it('approve -> approved regardless of rounds', () => {
    expect(resolveReviewVerdict({ reviewRound: 5, maxReviewRounds: 2 }, 'approve')).toEqual({
      next: 'approved',
      failure: null,
    });
  });

  it('request_changes under the limit -> changes_requested', () => {
    expect(
      resolveReviewVerdict({ reviewRound: 1, maxReviewRounds: 2 }, 'request_changes').next,
    ).toBe('changes_requested');
  });

  it('request_changes at the limit -> failed with REVIEW_ROUNDS_EXCEEDED', () => {
    const r = resolveReviewVerdict({ reviewRound: 2, maxReviewRounds: 2 }, 'request_changes');
    expect(r.next).toBe('failed');
    expect(r.failure?.code).toBe('REVIEW_ROUNDS_EXCEEDED');
  });
});
