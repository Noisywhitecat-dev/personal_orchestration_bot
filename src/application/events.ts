import type { ProjectId, TaskId } from '../domain/ids.js';
import type { ExecutionBudgetStatus } from '../domain/execution-limits.js';
import type { Message, TaskEvent } from '../domain/message.js';
import type { Run } from '../domain/run.js';
import type { Task } from '../domain/task.js';
import type { UsageSummary } from '../domain/usage.js';

/** Events pushed to UI clients (over SSE) whenever orchestration state changes. */
export type OrchestrationEvent =
  | { type: 'task_updated'; task: Task }
  | { type: 'run_updated'; run: Run }
  | { type: 'message_added'; message: Message }
  | { type: 'timeline_appended'; entry: TaskEvent }
  | {
      type: 'usage_updated';
      taskId: TaskId;
      projectId: ProjectId;
      task: UsageSummary;
      project: UsageSummary;
    }
  | { type: 'budget_updated'; taskId: TaskId; budget: ExecutionBudgetStatus }
  | { type: 'system_error'; code: string; message: string; taskId: TaskId | null };

export type Listener = (event: OrchestrationEvent) => void;

export class EventBus {
  private readonly listeners = new Set<Listener>();

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  publish(event: OrchestrationEvent): void {
    for (const l of this.listeners) {
      try {
        l(event);
      } catch {
        // A broken subscriber must not break orchestration.
      }
    }
  }
}
