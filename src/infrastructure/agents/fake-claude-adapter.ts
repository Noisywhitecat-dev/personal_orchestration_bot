import { setTimeout as pause } from 'node:timers/promises';
import type { AgentEvent } from '../../domain/agent-events.js';
import { asSessionId, type RunId, type SessionId, type TaskId } from '../../domain/ids.js';
import type { Clock, IdGenerator } from '../../domain/ports.js';
import type { AgentAdapter, AgentRunInput } from './agent-adapter.js';

export interface FakeClaudeOptions {
  /** Optional presentation delay. Tests default to zero; no external process. */
  delayMs?: number;
  /**
   * How many times to answer `request_changes` before approving, per task.
   * A prompt containing `[fake-changes:N]` overrides this for that task.
   */
  changeRequestsBeforeApprove?: number;
}

const MARKER = /\[fake-changes:(\d+)\]/;
const CLARIFY_MARKER = /\[fake-clarify:(\d+)\]/;

/**
 * Deterministic stand-in for the Claude Code CLI.
 * - plan: returns a fixed 3-step plan derived from the prompt.
 * - review: requests changes N times (see options), then approves.
 * Usage: plan reports `actual`, review reports `estimated` so the UI can show both labels.
 */
export class FakeClaudeAdapter implements AgentAdapter {
  readonly provider = 'claude' as const;
  private readonly changeTargets = new Map<TaskId, number>();
  private readonly reviewCounts = new Map<TaskId, number>();
  private readonly clarificationCounts = new Map<TaskId, number>();
  private readonly clarificationTargets = new Map<TaskId, number>();
  private readonly taskTitles = new Map<TaskId, string>();
  private readonly cancelled = new Set<RunId>();

  constructor(
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly options: FakeClaudeOptions = {},
  ) {}

  start(input: AgentRunInput): AsyncIterable<AgentEvent> {
    return this.run(asSessionId(`claude-session-${this.ids.next()}`), input);
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
      if (this.options.delayMs)
        await pause(this.options.delayMs, undefined, { signal: input.signal });
    } catch {
      /* cancellation checked below */
    }

    if (this.isCancelled(input)) {
      yield {
        ...base(),
        type: 'run_failed',
        error: { code: 'CANCELLED', message: 'Run cancelled.' },
      };
      return;
    }

    if (input.kind === 'plan') {
      if (!this.changeTargets.has(input.taskId))
        this.changeTargets.set(input.taskId, this.changeLimit(input.prompt));
      yield { ...base(), type: 'reasoning_delta', text: 'Analyzing request…' };
      yield { ...base(), type: 'message_delta', text: 'Here is the plan.' };
      yield {
        ...base(),
        type: 'usage_reported',
        usage: {
          inputTokens: 120,
          cachedInputTokens: 40,
          outputTokens: 80,
          reasoningTokens: null,
          totalTokens: 200,
          source: 'actual',
        },
      };
      if (!this.clarificationTargets.has(input.taskId)) {
        this.clarificationTargets.set(input.taskId, clarificationLimit(input.prompt));
        this.clarificationCounts.set(input.taskId, completedClarificationRounds(input.prompt));
        this.taskTitles.set(input.taskId, firstLine(input.prompt).slice(0, 60));
      }
      const clarificationCount = this.clarificationCounts.get(input.taskId) ?? 0;
      const clarificationTarget = this.clarificationTargets.get(input.taskId) ?? 0;
      if (clarificationCount < clarificationTarget) {
        const round = clarificationCount + 1;
        this.clarificationCounts.set(input.taskId, round);
        yield {
          ...base(),
          type: 'run_completed',
          result: {
            kind: 'clarification',
            question: `추가 질문 ${round}: 꼭 지켜야 할 조건을 알려주세요.`,
          },
        };
        return;
      }
      const title = this.taskTitles.get(input.taskId) ?? firstLine(input.prompt).slice(0, 60);
      yield {
        ...base(),
        type: 'run_completed',
        result: {
          kind: 'plan',
          title,
          summary: `요청을 구현합니다: ${title}`,
          objective: title,
          scope: ['관련 소스와 인접 테스트'],
          outOfScope: ['요청과 무관한 변경'],
          acceptanceCriteria: ['요청한 동작을 구현하고 검증 결과를 보고한다'],
          suggestedFiles: ['src/feature.ts', 'src/feature.test.ts'],
          verification: ['관련 테스트 실행'],
          risks: ['체험 결과는 실제 코드 변경이 아닙니다'],
          riskLevel: 'low',
          steps: ['관련 파일 확인', '요청 기능 구현', '테스트와 검토'],
        },
      };
      return;
    }

    if (input.kind === 'review') {
      const count = (this.reviewCounts.get(input.taskId) ?? 0) + 1;
      this.reviewCounts.set(input.taskId, count);
      const limit = this.changeTargets.get(input.taskId) ?? this.changeLimit(input.prompt);
      const requestChanges = count <= limit;

      yield { ...base(), type: 'message_delta', text: 'Reviewing diff and test results…' };
      yield {
        ...base(),
        type: 'usage_reported',
        usage: {
          inputTokens: 300,
          cachedInputTokens: null,
          outputTokens: 60,
          reasoningTokens: null,
          totalTokens: 360,
          source: 'estimated',
        },
      };
      yield {
        ...base(),
        type: 'run_completed',
        result: requestChanges
          ? {
              kind: 'review',
              verdict: 'request_changes',
              summary: `검토 ${count}회: 수정할 항목이 있습니다.`,
              changeRequests: [
                `검토에서 발견한 ${count}번 문제를 수정하고 관련 테스트를 확인하세요`,
              ],
            }
          : {
              kind: 'review',
              verdict: 'approve',
              summary: '수용 조건과 검증 결과를 확인했습니다.',
              changeRequests: [],
            },
      };
      return;
    }

    yield {
      ...base(),
      type: 'run_failed',
      error: { code: 'UNSUPPORTED_KIND', message: `FakeClaude cannot run kind '${input.kind}'.` },
    };
  }

  private changeLimit(prompt: string): number {
    const m = MARKER.exec(prompt);
    if (m?.[1] !== undefined) return Number(m[1]);
    return this.options.changeRequestsBeforeApprove ?? 0;
  }

  private isCancelled(input: AgentRunInput): boolean {
    return this.cancelled.has(input.runId) || input.signal?.aborted === true;
  }
}

function firstLine(text: string): string {
  const match = /<<<BEGIN_UNTRUSTED_REQUEST>>>\n([^\n]+)/.exec(text);
  if (match?.[1]) {
    try {
      return JSON.parse(match[1]) as string;
    } catch {
      /* old prompt */
    }
  }
  return text.split('\n')[0]?.trim() ?? '';
}

function clarificationLimit(prompt: string): number {
  const match = CLARIFY_MARKER.exec(prompt);
  return match?.[1] === undefined ? 0 : Number(match[1]);
}

function completedClarificationRounds(prompt: string): number {
  const match = /Completed clarification rounds: (\d+)\./.exec(prompt);
  return match?.[1] === undefined ? 0 : Number(match[1]);
}
