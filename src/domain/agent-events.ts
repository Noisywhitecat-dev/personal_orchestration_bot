import type { IsoTimestamp, RunId, SessionId } from './ids.js';
import type { UsageSnapshot } from './usage.js';
import type { TaskPlan } from './task.js';

/** Structured outputs an agent run can produce. Adapters must parse provider output into one of these. */
export type AgentResult =
  | ({ kind: 'plan' } & TaskPlan)
  | { kind: 'clarification'; question: string }
  | {
      kind: 'implementation';
      summary: string;
      changedFiles: string[];
      /** null when the agent did not run tests or did not report the outcome. */
      testsPassed: boolean | null;
      verificationResults?: string[] | undefined;
      deviations?: string[] | undefined;
      remainingRisks?: string[] | undefined;
    }
  | {
      kind: 'review';
      verdict: 'approve' | 'request_changes';
      summary: string;
      changeRequests: string[];
    };

export interface AgentError {
  code: string;
  message: string;
}

interface Base {
  runId: RunId;
  timestamp: IsoTimestamp;
}

export type AgentEvent =
  | (Base & { type: 'session_started'; sessionId: SessionId })
  | (Base & { type: 'message_delta'; text: string })
  | (Base & { type: 'reasoning_delta'; text: string })
  | (Base & { type: 'command_started'; commandId: string; command: string[]; cwd: string })
  | (Base & {
      type: 'command_completed';
      commandId: string;
      exitCode: number | null;
      stdoutTail?: string | undefined;
      stderrTail?: string | undefined;
    })
  | (Base & { type: 'usage_reported'; usage: UsageSnapshot })
  | (Base & { type: 'run_completed'; result: AgentResult })
  | (Base & { type: 'run_failed'; error: AgentError });

export type AgentEventType = AgentEvent['type'];
