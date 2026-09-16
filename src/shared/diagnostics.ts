import type { RuntimeStatusResponse, TaskDetailResponse } from './contracts.js';
import { TASK_STATES } from '../domain/task.js';

/** Whitelist only. Never serialize task objects, errors, event payloads, settings or arbitrary strings. */
export function diagnosticSummary(
  runtime: RuntimeStatusResponse | null,
  detail: TaskDetailResponse | null,
) {
  const count = (n: unknown) =>
    typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 ? n : null;
  return {
    schemaVersion: 1,
    mode: {
      claude: runtime?.claude.adapter === 'cli' ? '실제' : '체험',
      codex: runtime?.codex.adapter === 'cli' ? '실제' : '체험',
    },
    state: detail && TASK_STATES.includes(detail.task.state) ? detail.task.state : null,
    reviewRound: count(detail?.task.reviewRound),
    runs:
      detail?.runs.map((run) => ({
        provider: run.provider === 'claude' ? 'claude' : 'codex',
        kind: ['plan', 'implement', 'review', 'revise'].includes(run.kind) ? run.kind : null,
        status: ['running', 'completed', 'failed', 'cancelled'].includes(run.status)
          ? run.status
          : null,
      })) ?? [],
    tokens: {
      claude: count(detail?.usage.claude.totalTokens),
      codex: count(detail?.usage.codex.totalTokens),
    },
    interrupted: detail?.task.failure?.code === 'INTERRUPTED',
  };
}
