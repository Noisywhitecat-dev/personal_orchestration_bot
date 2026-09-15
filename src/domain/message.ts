import type { IsoTimestamp, MessageId, ProjectId, RunId, TaskEventId, TaskId } from './ids.js';

export type MessageRole = 'user' | 'claude' | 'codex' | 'system';

/** Chat-level messages shown in the center column. */
export interface Message {
  id: MessageId;
  projectId: ProjectId;
  taskId: TaskId | null;
  role: MessageRole;
  content: string;
  createdAt: IsoTimestamp;
}

/**
 * Timeline entries: normalized agent events plus orchestration milestones.
 * `payload` is JSON-serializable and bounded in size at write time.
 */
export interface TaskEvent {
  id: TaskEventId;
  taskId: TaskId;
  runId: RunId | null;
  type: string;
  payload: Record<string, unknown>;
  createdAt: IsoTimestamp;
}

/** Hard cap on text stored per timeline entry / message. Larger text is truncated. */
export const MAX_STORED_TEXT = 8_000;

export function truncateText(text: string, max = MAX_STORED_TEXT): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n…[truncated ${text.length - max} chars]`;
}
