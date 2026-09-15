import type { AgentEvent } from '../../domain/agent-events.js';
import type { RunId, SessionId, TaskId } from '../../domain/ids.js';
import type { AgentProvider, RunKind } from '../../domain/run.js';

export interface AgentRunInput {
  runId: RunId;
  taskId: TaskId;
  /** Canonical absolute project root. Adapters must confine the agent to it. */
  projectRoot: string;
  kind: RunKind;
  /** Prompt text handed to the agent. Adapters must not log it in full. */
  prompt: string;
  /** Optional cancellation. Adapters should stop yielding and kill child processes. */
  signal?: AbortSignal;
}

/**
 * Boundary between the orchestrator and any concrete AI CLI.
 * Implementations translate provider-specific output into normalized AgentEvents.
 * The stream MUST end with exactly one `run_completed` or `run_failed` event.
 */
export interface AgentAdapter {
  readonly provider: AgentProvider;
  start(input: AgentRunInput): AsyncIterable<AgentEvent>;
  resume(sessionId: SessionId, input: AgentRunInput): AsyncIterable<AgentEvent>;
  cancel(runId: RunId): Promise<void>;
}
