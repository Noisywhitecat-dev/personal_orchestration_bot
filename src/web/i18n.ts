import type { Message } from '../shared/contracts.js';
import type { AgentProvider, RunKind, RunStatus } from '../domain/run.js';
import type { TaskState } from '../domain/task.js';

const TASK_STATE_LABELS: Record<TaskState, string> = {
  draft: '계획 작성 중',
  awaiting_clarification: '추가 정보 대기',
  awaiting_approval: '계획 승인 대기',
  queued: '실행 대기',
  implementing: '구현 중',
  review_requested: '리뷰 요청됨',
  reviewing: '리뷰 중',
  changes_requested: '수정 요청됨',
  approved: '승인됨',
  completed: '완료',
  failed: '실패',
  cancelled: '취소됨',
};

const RUN_KIND_LABELS: Record<RunKind, string> = {
  plan: '계획',
  implement: '구현',
  review: '리뷰',
  revise: '수정',
};

const RUN_STATUS_LABELS: Record<RunStatus, string> = {
  running: '실행 중',
  completed: '완료',
  failed: '실패',
  cancelled: '취소됨',
};

const MESSAGE_ROLE_LABELS: Record<Message['role'], string> = {
  user: '나',
  claude: 'Claude',
  codex: 'Codex',
  system: '시스템',
};

const TIMELINE_TYPE_LABELS: Record<string, string> = {
  request_received: '요청 접수',
  state_changed: '상태 변경',
  clarification_requested: '추가 정보 요청',
  clarification_answered: '추가 정보 답변',
  clarification_limit_exceeded: '추가 정보 요청 한도 초과',
  run_started: 'AI 실행 시작',
  run_finished: 'AI 실행 종료',
  command_started: '명령 시작',
  command_completed: '명령 종료',
  session_started: '세션 시작',
  agent_message: 'AI 메시지',
  usage_reported: '사용량 기록',
  budget_blocked: '사용 한도 차단',
  result: '결과 수신',
  run_completed: '실행 결과 수신',
  run_failed: 'AI 실행 실패',
};

export const taskStateLabel = (state: TaskState): string => TASK_STATE_LABELS[state];
export const providerLabel = (provider: AgentProvider): string =>
  provider === 'claude' ? 'Claude' : 'Codex';
export const runKindLabel = (kind: RunKind): string => RUN_KIND_LABELS[kind];
export const runStatusLabel = (status: RunStatus): string => RUN_STATUS_LABELS[status];
export const messageRoleLabel = (role: Message['role']): string => MESSAGE_ROLE_LABELS[role];
export const timelineTypeLabel = (type: string): string => TIMELINE_TYPE_LABELS[type] ?? type;

export function valueLabel(value: unknown): string {
  if (typeof value !== 'string') return String(value);
  if (value in TASK_STATE_LABELS) return TASK_STATE_LABELS[value as TaskState];
  if (value in RUN_KIND_LABELS) return RUN_KIND_LABELS[value as RunKind];
  if (value in RUN_STATUS_LABELS) return RUN_STATUS_LABELS[value as RunStatus];
  if (value === 'claude') return 'Claude';
  if (value === 'codex') return 'Codex';
  if (value === 'actual') return '실제 측정';
  if (value === 'estimated') return '추정';
  if (value === 'unavailable') return '확인 불가';
  if (value === 'unlimited') return '무제한';
  if (value === 'fake') return '체험 모드';
  if (value === 'cli') return '실제 AI';
  if (value === 'not_required') return '확인 불필요';
  if (value === 'configured') return '설정됨';
  if (value === 'ready') return '사용 가능';
  if (value === 'not_ready') return '사용 불가';
  return value;
}
