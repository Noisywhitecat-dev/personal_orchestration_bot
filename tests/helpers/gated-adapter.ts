import type { AgentEvent, AgentResult } from '../../src/domain/agent-events.js';
import type { RunId, SessionId } from '../../src/domain/ids.js';
import type { RunKind } from '../../src/domain/run.js';
import type { AgentAdapter, AgentRunInput } from '../../src/infrastructure/agents/agent-adapter.js';

/** How a gated run should proceed once released. */
export type Release =
  | { mode: 'pass' }
  | { mode: 'fail'; code: string; message: string }
  | { mode: 'result'; result: AgentResult };

interface Gate {
  input: AgentRunInput;
  resolve: (r: Release) => void;
}

/**
 * Test-only wrapper that holds selected runs at a gate until the test releases them.
 * Lets tests prove ordering (draft returned before planning finishes, cancel during
 * planning, late results after cancel) without timers. Not a production dependency.
 */
export class GatedAdapter implements AgentAdapter {
  readonly provider: AgentAdapter['provider'];
  private readonly gates: Gate[] = [];
  private waiters: Array<() => void> = [];

  constructor(
    private readonly inner: AgentAdapter,
    private readonly gatedKinds: readonly RunKind[] = ['plan'],
  ) {
    this.provider = inner.provider;
  }

  start(input: AgentRunInput): AsyncIterable<AgentEvent> {
    return this.wrap(input, () => this.inner.start(input));
  }

  resume(sessionId: SessionId, input: AgentRunInput): AsyncIterable<AgentEvent> {
    return this.wrap(input, () => this.inner.resume(sessionId, input));
  }

  cancel(runId: RunId): Promise<void> {
    return this.inner.cancel(runId);
  }

  /** Number of runs currently waiting at the gate. */
  get pending(): number {
    return this.gates.length;
  }

  /** Resolves once at least one run is waiting at the gate. */
  waitForPending(): Promise<void> {
    if (this.gates.length > 0) return Promise.resolve();
    return new Promise((r) => this.waiters.push(r));
  }

  /** Release the oldest waiting run. Throws if none is waiting. */
  release(how: Release = { mode: 'pass' }): AgentRunInput {
    const gate = this.gates.shift();
    if (!gate) throw new Error('GatedAdapter: no pending run to release');
    gate.resolve(how);
    return gate.input;
  }

  private async *wrap(
    input: AgentRunInput,
    open: () => AsyncIterable<AgentEvent>,
  ): AsyncGenerator<AgentEvent> {
    if (!this.gatedKinds.includes(input.kind)) {
      yield* open();
      return;
    }

    const release = await new Promise<Release | 'aborted'>((resolve) => {
      const gate: Gate = { input, resolve };
      const onAbort = () => {
        const i = this.gates.indexOf(gate);
        if (i >= 0) this.gates.splice(i, 1);
        resolve('aborted');
      };
      if (input.signal?.aborted) {
        resolve('aborted');
        return;
      }
      input.signal?.addEventListener('abort', onAbort, { once: true });
      this.gates.push(gate);
      const ws = this.waiters;
      this.waiters = [];
      for (const w of ws) w();
    });

    const base = { runId: input.runId, timestamp: '2026-01-01T00:00:00.000Z' };
    if (release === 'aborted') {
      yield {
        ...base,
        type: 'run_failed',
        error: { code: 'CANCELLED', message: 'Run cancelled.' },
      };
      return;
    }
    if (release.mode === 'fail') {
      yield {
        ...base,
        type: 'run_failed',
        error: { code: release.code, message: release.message },
      };
      return;
    }
    if (release.mode === 'result') {
      yield { ...base, type: 'run_completed', result: release.result };
      return;
    }
    yield* open();
  }
}
