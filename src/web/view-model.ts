import type { ProviderBudgetStatus, Task } from '../shared/contracts.js';
import type { TaskState } from '../domain/task.js';
import { taskStateLabel } from './i18n.js';

export function taskPresentation(task: Task | null): {
  stage: string;
  next: string;
  action: 'submit' | 'answer' | 'approve' | 'new' | 'wait';
  button: string;
} {
  if (!task)
    return {
      stage: '새 작업',
      next: '원하는 결과를 편하게 적어주세요. Claude가 계획을 정리합니다.',
      action: 'submit',
      button: '계획 만들기',
    };
  const states: Record<
    TaskState,
    { stage: string; next: string; action: 'answer' | 'approve' | 'new' | 'wait'; button: string }
  > = {
    draft: {
      stage: 'Claude가 계획을 만드는 중',
      next: '요청을 정리하고 있습니다. 잠시 기다려주세요.',
      action: 'wait',
      button: '계획 작성 중…',
    },
    awaiting_clarification: {
      stage: '추가 답변 필요',
      next: 'Claude의 질문에 답하면 계획을 이어서 만듭니다.',
      action: 'answer',
      button: '답변 보내기',
    },
    awaiting_approval: {
      stage: '계획 확인 필요',
      next: '계획과 실행 요약을 확인하고 승인하세요.',
      action: 'approve',
      button: '계획 승인하고 시작',
    },
    queued: {
      stage: '코드 작성 준비 중',
      next: '승인한 범위 안에서 작업을 시작합니다.',
      action: 'wait',
      button: '준비 중…',
    },
    implementing: {
      stage: 'Codex가 코드를 작성하는 중',
      next: '구현과 필요한 검증을 진행합니다.',
      action: 'wait',
      button: '코드 작성 중…',
    },
    review_requested: {
      stage: 'Claude 검토 준비 중',
      next: '변경 내용과 검증 결과를 준비합니다.',
      action: 'wait',
      button: '검토 준비 중…',
    },
    reviewing: {
      stage: 'Claude가 결과를 검토하는 중',
      next: '승인한 조건을 충족했는지 확인합니다.',
      action: 'wait',
      button: '결과 검토 중…',
    },
    changes_requested: {
      stage: 'Codex가 검토 의견을 반영하는 중',
      next: '같은 작업에서 필요한 부분을 수정합니다.',
      action: 'wait',
      button: '수정 중…',
    },
    approved: {
      stage: '검토 통과',
      next: '완료 결과를 정리합니다.',
      action: 'wait',
      button: '마무리 중…',
    },
    completed: {
      stage: '완료됨',
      next: '변경 파일과 검증 결과를 확인하세요.',
      action: 'new',
      button: '새 작업 만들기',
    },
    failed: {
      stage: '작업을 마치지 못했습니다',
      next: `${task.failure?.message && /[가-힣]/.test(task.failure.message) ? task.failure.message : (nextAction(task) ?? '작업 상태를 확인한 뒤 새 요청을 작성하세요.')} 자동으로 다시 실행하지 않습니다. 새 요청은 추가 AI 호출을 사용합니다.`,
      action: 'new',
      button: '새 작업으로 다시 요청',
    },
    cancelled: {
      stage: '작업이 중단되었습니다',
      next:
        task.failure?.code === 'INTERRUPTED'
          ? '재시작으로 중단되었습니다. 자동 재실행은 하지 않습니다. 새 요청은 추가 AI 호출을 사용합니다.'
          : '기존 변경은 남아 있을 수 있습니다. 새 요청 전에 결과를 확인하세요.',
      action: 'new',
      button: '새 작업 만들기',
    },
  };
  return states[task.state];
}

export function errorGuidance(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  if (/INVALID_PROJECT_ROOT/.test(text))
    return '프로젝트 폴더에 접근하지 못했습니다. 존재하는 폴더를 다시 선택하세요.';
  if (/VALIDATION_FAILED/.test(text))
    return '입력한 설정을 적용할 수 없습니다. 경로와 실행 한도, 모델의 지원 노력치를 확인하세요.';
  if (/fetch|Network|연결/i.test(text))
    return '로컬 서버에 연결하지 못했습니다. 설정 적용 중이면 잠시 기다린 뒤 새로 고침하세요.';
  if (/INVALID_TRANSITION|APPROVAL_REQUIRED/.test(text))
    return '작업 상태가 바뀌었습니다. 새로 고침한 뒤 현재 단계의 버튼을 사용하세요.';
  return '요청을 처리하지 못했습니다. 실행 전 점검과 앱 설정을 확인한 뒤 다시 시도하세요.';
}

export function safeMessage(role: string, content: string): string {
  if (role !== 'system') return content;
  if (content.startsWith('Task failed'))
    return '작업이 중단되었습니다. 현재 단계의 복구 안내를 확인하세요.';
  if (content.startsWith('Plan approved'))
    return '계획을 승인했습니다. Codex가 코드 작성을 시작합니다.';
  if (content.startsWith('Task completed')) return '작업이 완료되었습니다.';
  if (content.startsWith('Plan rejected')) return '계획을 거절했습니다.';
  if (content.startsWith('Task cancelled')) return '작업을 취소했습니다.';
  return content.replace(/\b(draft|queued|review_requested)\b/g, (s) =>
    taskStateLabel(s as TaskState),
  );
}

export function tokenRangeLabel(status: ProviderBudgetStatus): string {
  if (status.tokenCeiling === null) return '무제한';
  if (status.reliableRemainingTokens !== null) {
    return `${status.reliableRemainingTokens.toLocaleString()}토큰 남음`;
  }
  const confidence = status.tokenConfidence === 'estimated' ? '추정' : '확인 불가';
  return `확인된 토큰 ${status.knownTokens.toLocaleString()} / 상한 ${status.tokenCeiling.toLocaleString()} (${confidence})`;
}

export function nextAction(task: Task): string | null {
  if (!task.failure) return null;
  if (task.failure.code.includes('RUN_LIMIT') || task.failure.code.includes('TOKEN_CEILING')) {
    return '기록된 사용량을 확인한 뒤 실행 한도를 높여 새 작업을 만드세요.';
  }
  if (task.failure.code === 'CLARIFICATION_ROUNDS_EXCEEDED') {
    return '누락된 내용을 요청에 포함하거나 추가 질문 한도를 높여 새 작업을 만드세요.';
  }
  if (task.failure.code === 'INTERRUPTED')
    return '작업 기록을 확인한 뒤 새 작업으로 다시 요청하세요.';
  return '진행 기록에서 원인을 확인하고 문제를 해결한 뒤 새 작업으로 다시 요청하세요.';
}
