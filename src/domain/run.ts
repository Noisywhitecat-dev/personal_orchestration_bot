import type { IsoTimestamp, ProjectId, RunId, SessionId, TaskId } from './ids.js';

export type AgentProvider = 'claude' | 'codex';

/** What the agent is being asked to do in this run. */
export type RunKind = 'plan' | 'implement' | 'review' | 'revise';

export type RunStatus = 'running' | 'completed' | 'failed' | 'cancelled';

export interface Run {
  id: RunId;
  taskId: TaskId;
  projectId: ProjectId;
  provider: AgentProvider;
  kind: RunKind;
  status: RunStatus;
  sessionId: SessionId | null;
  startedAt: IsoTimestamp;
  finishedAt: IsoTimestamp | null;
  error: { code: string; message: string } | null;
}
