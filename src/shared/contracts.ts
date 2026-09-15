import { z } from 'zod';

import type { OrchestrationEvent } from '../application/events.js';
import type { Message, TaskEvent } from '../domain/message.js';
import type { Project } from '../domain/project.js';
import type { Run } from '../domain/run.js';
import type { Task } from '../domain/task.js';
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
});
export type SubmitRequestBody = z.infer<typeof SubmitRequestBody>;

export const RejectTaskBody = z.object({
  reason: z.string().trim().max(2_000).optional(),
});
export type RejectTaskBody = z.infer<typeof RejectTaskBody>;

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
}

/** SSE payload: identical to the in-process event. */
export type SseEvent = OrchestrationEvent;

export type { Message, Project, Run, Task, TaskEvent, UsageSummary };
