import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { Task, RuntimeStatusResponse } from '../shared/contracts.js';
vi.mock('./desktop-bridge.js', () => ({ desktopBridge: undefined }));
import { ProjectSidebar } from './components/ProjectSidebar.js';
import { SidebarSettings } from './components/SidebarSettings.js';
import { DeleteTaskDialog } from './components/DeleteTaskDialog.js';

const task = {
  id: 'task-a',
  request: 'test <script>request</script>',
  state: 'completed',
  createdAt: '2026-09-16T00:00:00Z',
  plan: null,
} as Task;
const renderSidebar = (state: Task['state'], busy = false) =>
  renderToStaticMarkup(
    createElement(ProjectSidebar, {
      projects: [],
      tasks: [{ ...task, state }],
      taskId: task.id,
      projectId: null,
      runtime: null,
      busy,
      onProject: () => {},
      onTask: () => {},
      onNew: () => {},
      onRegister: async () => true,
      onSettings: () => {},
      onGuide: () => {},
      onDelete: async () => true,
    }),
  );
describe('sidebar history and account controls', () => {
  it.each([
    'draft',
    'awaiting_approval',
    'awaiting_clarification',
    'implementing',
    'reviewing',
  ] as const)('disables deletion during %s', (state) => {
    expect(renderSidebar(state)).toMatch(/aria-label="대화 삭제:[^"]*" disabled=""/);
  });
  it.each(['completed', 'cancelled', 'failed'] as const)(
    'allows only idle terminal deletion (%s), with an escaped scoped confirmation',
    (state) => {
      expect(renderSidebar(state)).not.toMatch(/aria-label="대화 삭제:[^"]*" disabled=""/);
      expect(renderSidebar(state, true)).toMatch(/aria-label="대화 삭제:[^"]*" disabled=""/);
      const html = renderToStaticMarkup(
        createElement(DeleteTaskDialog, {
          task: { ...task, state },
          onDelete: async () => true,
          onClose: () => {},
        }),
      );
      expect(html).toContain('aria-labelledby="delete-title"');
      expect(html).toContain('autofocus=""');
      expect(html).toContain('&lt;script&gt;');
      expect(html).not.toContain('<script>');
      expect(html).toContain('프로젝트 파일과 계정의 실제 사용량은 바뀌지 않습니다.');
    },
  );
  it('shows effective CLI model and effort beside distinct account windows without fake quota values', () => {
    const runtime = {
      claude: { adapter: 'cli', model: 'sonnet', effort: 'medium' },
      codex: { adapter: 'cli', model: 'gpt-5.6-terra', effort: 'high' },
    } as RuntimeStatusResponse;
    const html = renderToStaticMarkup(
      createElement(SidebarSettings, { runtime, onSettings: () => {} }),
    );
    expect(html).toContain('sonnet');
    expect(html).toContain('medium');
    expect(html).toContain('gpt-5.6-terra');
    expect(html).toContain('high');
    expect(html).toContain('Codex 주간');
    expect(html).toContain('Claude 5시간');
    expect(html).toContain('Claude 주간');
    expect(html).not.toContain('<progress');
    expect(html).toContain('확인 불가');
  });
});
