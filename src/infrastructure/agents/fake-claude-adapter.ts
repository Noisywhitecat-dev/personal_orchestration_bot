import type { AgentEvent } from '../../domain/agent-events.js';
import { asSessionId, type RunId, type SessionId, type TaskId } from '../../domain/ids.js';
import type { Clock, IdGenerator } from '../../domain/ports.js';
import type { AgentAdapter, AgentRunInput } from './agent-adapter.js';

export interface FakeClaudeOptions {
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

    if (this.isCancelled(input)) {
      yield {
        ...base(),
        type: 'run_failed',
        error: { code: 'CANCELLED', message: 'Run cancelled.' },
      };
      return;
    }

    if (input.kind === 'plan') {
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
            question: `Clarification ${round}: what constraint should Claude use?`,
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
          summary: `Implement: ${title}`,
          steps: ['Inspect relevant files', 'Implement the change', 'Add or update tests'],
        },
      };
      return;
    }

    if (input.kind === 'review') {
      const count = (this.reviewCounts.get(input.taskId) ?? 0) + 1;
      this.reviewCounts.set(input.taskId, count);
      const limit = this.changeLimit(input.prompt);
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
              summary: `Round ${count}: changes needed.`,
              changeRequests: [`Fix issue #${count} found in review`],
            }
          : { kind: 'review', verdict: 'approve', summary: 'Looks good.', changeRequests: [] },
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
