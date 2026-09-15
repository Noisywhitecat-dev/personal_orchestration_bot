import type { IsoTimestamp, ProjectId, SessionId, TaskId } from './ids.js';

export const TASK_STATES = [
  'draft',
  'awaiting_approval',
  'queued',
  'implementing',
  'review_requested',
  'reviewing',
  'changes_requested',
  'approved',
  'completed',
  'failed',
  'cancelled',
] as const;

export type TaskState = (typeof TASK_STATES)[number];

export const TERMINAL_STATES: ReadonlySet<TaskState> = new Set<TaskState>([
  'completed',
  'failed',
  'cancelled',
]);

export function isTerminal(state: TaskState): boolean {
  return TERMINAL_STATES.has(state);
}

export const DEFAULT_MAX_REVIEW_ROUNDS = 2;

/** Structured plan produced by the planner (Claude). */
export interface TaskPlan {
  title: string;
  summary: string;
  steps: string[];
}

/** One review verdict, appended per review round. */
export interface ReviewOutcome {
  round: number;
  verdict: 'approve' | 'request_changes';
  summary: string;
  changeRequests: string[];
  recordedAt: IsoTimestamp;
}

export interface Task {
  id: TaskId;
  projectId: ProjectId;
  /** Original user request text. */
  request: string;
  state: TaskState;
  plan: TaskPlan | null;
  /** Number of completed review rounds. */
  reviewRound: number;
  maxReviewRounds: number;
  reviews: ReviewOutcome[];
  /** Implementer session, reused across revision rounds. */
  codexSessionId: SessionId | null;
  /** Planner/reviewer session, reused across plan + reviews. */
  claudeSessionId: SessionId | null;
  /** Set when the task ends in `failed`. */
  failure: { code: string; message: string } | null;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}
