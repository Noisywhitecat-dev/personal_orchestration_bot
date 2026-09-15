import { OrchestrationError } from './errors.js';
import type { IsoTimestamp } from './ids.js';
import type { Task, TaskState } from './task.js';

/**
 * The single source of truth for allowed task transitions.
 * Anything not listed here is rejected with INVALID_TRANSITION.
 */
export const TRANSITIONS: Readonly<Record<TaskState, readonly TaskState[]>> = {
  draft: ['awaiting_approval', 'failed', 'cancelled'],
  awaiting_approval: ['queued', 'cancelled'],
  queued: ['implementing', 'cancelled'],
  implementing: ['review_requested', 'failed', 'cancelled'],
  review_requested: ['reviewing', 'cancelled'],
  reviewing: ['approved', 'changes_requested', 'failed', 'cancelled'],
  changes_requested: ['implementing', 'failed', 'cancelled'],
  approved: ['completed'],
  completed: [],
  failed: [],
  cancelled: [],
};

/** Transitions that are only legal when the user has explicitly approved. */
const APPROVAL_GATED: ReadonlyArray<readonly [TaskState, TaskState]> = [
  ['awaiting_approval', 'queued'],
];

export interface TransitionOptions {
  /** Must be true for approval-gated transitions. Defaults to false. */
  userApproved?: boolean;
}

export function canTransition(from: TaskState, to: TaskState): boolean {
  return TRANSITIONS[from].includes(to);
}

function requiresApproval(from: TaskState, to: TaskState): boolean {
  return APPROVAL_GATED.some(([f, t]) => f === from && t === to);
}

/**
 * Validate a transition. Throws OrchestrationError on failure.
 * Pure: does not mutate anything.
 */
export function assertTransition(
  from: TaskState,
  to: TaskState,
  options: TransitionOptions = {},
): void {
  if (!canTransition(from, to)) {
    throw new OrchestrationError(
      'INVALID_TRANSITION',
      `Task cannot move from '${from}' to '${to}'.`,
      { from, to },
    );
  }
  if (requiresApproval(from, to) && options.userApproved !== true) {
    throw new OrchestrationError(
      'APPROVAL_REQUIRED',
      `Moving from '${from}' to '${to}' requires explicit user approval.`,
      { from, to },
    );
  }
}

/**
 * Return a new Task in state `to`. Never mutates the input.
 */
export function transition(
  task: Task,
  to: TaskState,
  now: IsoTimestamp,
  options: TransitionOptions = {},
): Task {
  assertTransition(task.state, to, options);
  return { ...task, state: to, updatedAt: now };
}

/**
 * Decide the next state after a review verdict, enforcing the round limit.
 * Returns the state and, when the limit is exceeded, the failure to record.
 */
export function resolveReviewVerdict(
  task: Pick<Task, 'reviewRound' | 'maxReviewRounds'>,
  verdict: 'approve' | 'request_changes',
): {
  next: 'approved' | 'changes_requested' | 'failed';
  failure: { code: string; message: string } | null;
} {
  if (verdict === 'approve') {
    return { next: 'approved', failure: null };
  }
  // reviewRound is the count *after* this review has been counted.
  if (task.reviewRound >= task.maxReviewRounds) {
    return {
      next: 'failed',
      failure: {
        code: 'REVIEW_ROUNDS_EXCEEDED',
        message: `Review requested changes after ${task.reviewRound} of ${task.maxReviewRounds} allowed rounds. User decision required.`,
      },
    };
  }
  return { next: 'changes_requested', failure: null };
}
