import { describe, expect, it } from 'vitest';

import { TASK_STATES } from '../domain/task.js';
import {
  messageRoleLabel,
  runKindLabel,
  runStatusLabel,
  taskStateLabel,
  timelineTypeLabel,
  valueLabel,
} from './i18n.js';

describe('웹 한글 표시', () => {
  it('모든 작업 상태에 한글 이름을 제공한다', () => {
    for (const state of TASK_STATES) {
      expect(taskStateLabel(state)).not.toBe(state);
    }
  });

  it('역할과 실행 정보를 한글로 표시한다', () => {
    expect(messageRoleLabel('user')).toBe('나');
    expect(runKindLabel('implement')).toBe('구현');
    expect(runStatusLabel('running')).toBe('실행 중');
  });

  it('실행 환경과 알려진 진행 기록을 한글로 표시한다', () => {
    expect(valueLabel('not_required')).toBe('확인 불필요');
    expect(valueLabel('estimated')).toBe('추정');
    expect(timelineTypeLabel('state_changed')).toBe('상태 변경');
    expect(timelineTypeLabel('future_event')).toBe('future_event');
  });
});
