import { z } from 'zod';

import type { OrchestrationEvent } from '../application/events.js';
import type {
  ExecutionBudgetStatus,
  ExecutionLimitsInput,
  ProviderBudgetStatus,
} from '../domain/execution-limits.js';
import type { Message, TaskEvent } from '../domain/message.js';
import type { Project } from '../domain/project.js';
import type { Run as DomainRun } from '../domain/run.js';
import type { Task as DomainTask } from '../domain/task.js';
import type { UsageSummary } from '../domain/usage.js';

// Request schemas (validated at the server boundary) and response shapes (shared with the web UI).

export const RegisterProjectBody = z.object({
  name: z.string().trim().min(1).max(100),
  rootPath: z.string().trim().min(1).max(1000),
});
export type RegisterProjectBody = z.infer<typeof RegisterProjectBody>;

export const SubmitRequestBody = z.object({
  projectId: z.string().min(1),
  request: z.string().trim().min(1).max(20_000),
  executionLimits: z
    .object({
      maxClaudeRuns: z.number().int().positive().max(100),
      maxCodexRuns: z.number().int().positive().max(100),
      claudeTokenCeiling: z.number().int().positive().safe().nullable(),
      codexTokenCeiling: z.number().int().positive().safe().nullable(),
      maxClarificationRounds: z.number().int().positive().max(20),
      maxReviewRounds: z.number().int().positive().max(20),
    })
    .strict()
    .optional(),
});
export type SubmitRequestBody = z.infer<typeof SubmitRequestBody>;

export const RejectTaskBody = z.object({
  reason: z.string().trim().max(2_000).optional(),
});
export type RejectTaskBody = z.infer<typeof RejectTaskBody>;

export const ClarificationAnswerBody = z
  .object({ answer: z.string().trim().min(1).max(20_000) })
  .strict();
export type ClarificationAnswerBody = z.infer<typeof ClarificationAnswerBody>;

export type Task = Omit<DomainTask, 'codexSessionId' | 'claudeSessionId'> & {
  hasCodexSession: boolean;
  hasClaudeSession: boolean;
};

export type Run = Omit<DomainRun, 'sessionId'> & { hasSession: boolean };

export function toPublicTask(task: DomainTask): Task {
  const { codexSessionId, claudeSessionId, ...safe } = task;
  return {
    ...safe,
    hasCodexSession: codexSessionId !== null,
    hasClaudeSession: claudeSessionId !== null,
  };
}

export function toPublicRun(run: DomainRun): Run {
  const { sessionId, ...safe } = run;
  return { ...safe, hasSession: sessionId !== null };
}

/** Also sanitizes legacy v1 timeline rows that persisted the actual session id. */
export function toPublicTaskEvent(event: TaskEvent): TaskEvent {
  if (event.type === 'session_started') {
    return { ...event, payload: { sessionPresent: true } };
  }
  if (event.type === 'command_completed') {
    const { stdoutTail, stderrTail, ...safe } = event.payload;
    return {
      ...event,
      payload: {
        ...safe,
        ...(typeof stdoutTail === 'string' ? { stdoutPresent: stdoutTail.length > 0 } : {}),
        ...(typeof stderrTail === 'string' ? { stderrPresent: stderrTail.length > 0 } : {}),
      },
    };
  }
  return event;
}

export interface ApiError {
  error: { code: string; message: string };
}

export interface ProjectDetailResponse {
  project: Project;
  tasks: Task[];
  messages: Message[];
  usage: UsageSummary;
}

export interface TaskDetailResponse {
  task: Task;
  runs: Run[];
  timeline: TaskEvent[];
  usage: UsageSummary;
  budget: ExecutionBudgetStatus;
}

export interface RuntimeStatusResponse {
  claude: {
    adapter: 'fake' | 'cli';
    executable: ExecutableStatus;
    timeoutMs: number;
    model: string | null;
    effort: string | null;
  };
  codex: {
    adapter: 'fake' | 'cli';
    executable: ExecutableStatus;
    timeoutMs: number;
    model: string | null;
    effort: string | null;
  };
  reviewDiffMaxBytes: number;
  database: string;
  defaultExecutionLimits: ExecutionLimitsInput;
}

export type ExecutableStatus = 'not_required' | 'configured' | 'ready' | 'not_ready';

/** Public SSE payload. Session identifiers are deliberately removed. */
export type SseEvent =
  | { type: 'task_updated'; task: Task }
  | { type: 'run_updated'; run: Run }
  | Extract<
      OrchestrationEvent,
      {
        type:
          | 'message_added'
          | 'timeline_appended'
          | 'usage_updated'
          | 'budget_updated'
          | 'system_error';
      }
    >;

export function toPublicEvent(event: OrchestrationEvent): SseEvent {
  if (event.type === 'task_updated') return { type: event.type, task: toPublicTask(event.task) };
  if (event.type === 'run_updated') return { type: event.type, run: toPublicRun(event.run) };
  if (event.type === 'timeline_appended') {
    return { type: event.type, entry: toPublicTaskEvent(event.entry) };
  }
  return event;
}

export type {
  ExecutionBudgetStatus,
  ExecutionLimitsInput,
  Message,
  Project,
  ProviderBudgetStatus,
  TaskEvent,
  UsageSummary,
};
