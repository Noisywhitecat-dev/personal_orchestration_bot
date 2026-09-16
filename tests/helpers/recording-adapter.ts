import type { AgentEvent } from '../../src/domain/agent-events.js';
import type { RunId, SessionId } from '../../src/domain/ids.js';
import type { AgentAdapter, AgentRunInput } from '../../src/infrastructure/agents/agent-adapter.js';

/** Test-only wrapper that records every run input (prompt included) and delegates to `inner`. */
export class RecordingAdapter implements AgentAdapter {
  readonly provider: AgentAdapter['provider'];
  readonly inputs: AgentRunInput[] = [];
  readonly resumedSessions: SessionId[] = [];

  constructor(private readonly inner: AgentAdapter) {
    this.provider = inner.provider;
  }

  start(input: AgentRunInput): AsyncIterable<AgentEvent> {
    this.inputs.push(input);
    return this.inner.start(input);
  }

  resume(sessionId: SessionId, input: AgentRunInput): AsyncIterable<AgentEvent> {
    this.resumedSessions.push(sessionId);
    this.inputs.push(input);
    return this.inner.resume(sessionId, input);
  }

  cancel(runId: RunId): Promise<void> {
    return this.inner.cancel(runId);
  }

  /** Prompts of runs with the given kind, in order. */
  prompts(kind: AgentRunInput['kind']): string[] {
    return this.inputs.filter((i) => i.kind === kind).map((i) => i.prompt);
  }
}
