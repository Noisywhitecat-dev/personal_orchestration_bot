import { setTimeout as pause } from 'node:timers/promises';
import type { AgentEvent } from '../../domain/agent-events.js';
import { asSessionId, type RunId, type SessionId } from '../../domain/ids.js';
import type { Clock, IdGenerator } from '../../domain/ports.js';
import type { AgentAdapter, AgentRunInput } from './agent-adapter.js';

export interface FakeCodexOptions {
  /** Optional presentation delay. Tests default to zero; no external process. */
  delayMs?: number;
  /** If the prompt contains this marker the run fails. Useful for failure-path tests. */
  failMarker?: string;
}

/**
 * Deterministic stand-in for the Codex CLI.
 * Emits a session, a couple of message deltas, one fake `npm test` command,
 * actual-source usage, and an implementation result. Optional presentation delay, no processes.
 */
export class FakeCodexAdapter implements AgentAdapter {
  readonly provider = 'codex' as const;
  private readonly cancelled = new Set<RunId>();
  private readonly failMarker: string;
  private readonly delayMs: number;

  constructor(
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    options: FakeCodexOptions = {},
  ) {
    this.delayMs = options.delayMs ?? 0;
    this.failMarker = options.failMarker ?? '[fake-fail]';
  }

  start(input: AgentRunInput): AsyncIterable<AgentEvent> {
    return this.run(asSessionId(`codex-session-${this.ids.next()}`), input);
  }

  resume(sessionId: SessionId, input: AgentRunInput): AsyncIterable<AgentEvent> {
    return this.run(sessionId, input);
  }

  async cancel(runId: RunId): Promise<void> {
    this.cancelled.add(runId);
  }

  private async *run(sessionId: SessionId, input: AgentRunInput): AsyncGenerator<AgentEvent> {
    const base = () => ({ runId: input.runId, timestamp: this.clock.now() });
    yield { ...base(), type: 'session_started', sessionId };
    try {
      if (this.delayMs) await pause(this.delayMs, undefined, { signal: input.signal });
    } catch {
      /* cancellation checked below */
    }

    if (this.cancelled.has(input.runId) || input.signal?.aborted === true) {
      yield {
        ...base(),
        type: 'run_failed',
        error: { code: 'CANCELLED', message: 'Run cancelled.' },
      };
      return;
    }

    if (input.prompt.includes(this.failMarker)) {
      yield { ...base(), type: 'message_delta', text: 'Attempting implementation…' };
      yield {
        ...base(),
        type: 'run_failed',
        error: { code: 'IMPLEMENTATION_FAILED', message: 'Fake implementation failure.' },
      };
      return;
    }

    const revising = input.kind === 'revise';
    yield {
      ...base(),
      type: 'message_delta',
      text: revising ? 'Applying requested changes…' : 'Implementing the plan…',
    };

    const commandId = `cmd-${this.ids.next()}`;
    yield {
      ...base(),
      type: 'command_started',
      commandId,
      command: ['npm', 'test'],
      cwd: input.projectRoot,
    };
    yield {
      ...base(),
      type: 'command_completed',
      commandId,
      exitCode: 0,
      stdoutTail: 'Tests: 3 passed',
    };

    yield {
      ...base(),
      type: 'usage_reported',
      usage: {
        inputTokens: revising ? 500 : 800,
        cachedInputTokens: revising ? 300 : 0,
        outputTokens: revising ? 150 : 400,
        reasoningTokens: 100,
        totalTokens: revising ? 750 : 1300,
        source: 'actual',
      },
    };

    yield {
      ...base(),
      type: 'run_completed',
      result: {
        kind: 'implementation',
        summary: revising
          ? '검토에서 요청한 수정을 반영했습니다.'
          : '계획에 따른 코드 작성을 마쳤습니다.',
        verificationResults: ['체험용 테스트 통과 (실제 명령 실행 없음)'],
        deviations: [],
        remainingRisks: ['체험 결과이며 실제 파일을 수정하지 않았습니다'],
        changedFiles: revising ? ['src/feature.ts'] : ['src/feature.ts', 'src/feature.test.ts'],
        testsPassed: true,
      },
    };
  }
}
