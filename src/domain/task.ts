import type { IsoTimestamp, ProjectId, SessionId, TaskId } from './ids.js';

export const TASK_STATES = [
  'draft',
  'awaiting_clarification',
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
  /** Optional for compatibility with stored pre-M17 plans. */
  objective?: string | undefined;
  scope?: string[] | undefined;
  outOfScope?: string[] | undefined;
  acceptanceCriteria?: string[] | undefined;
  suggestedFiles?: string[] | undefined;
  verification?: string[] | undefined;
  risks?: string[] | undefined;
  riskLevel?: 'low' | 'medium' | 'high' | undefined;
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
  /** Number of clarification questions returned by Claude. */
  clarificationRound: number;
  maxClarificationRounds: number;
  /** Number of completed review rounds. */
  reviewRound: number;
  maxReviewRounds: number;
  maxClaudeRuns: number;
  maxCodexRuns: number;
  /** Run-boundary ceilings. null means unlimited; a single run may cross the ceiling. */
  claudeTokenCeiling: number | null;
  codexTokenCeiling: number | null;
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
