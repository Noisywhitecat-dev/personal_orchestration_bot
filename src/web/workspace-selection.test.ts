import { describe, expect, it } from 'vitest';
import { WorkspaceSelection } from './workspace-selection.js';
import type { ProjectDetailResponse, TaskDetailResponse } from '../shared/contracts.js';

const project = (id: string, taskIds: string[]) =>
  ({
    project: { id },
    tasks: taskIds.map((id, n) => ({ id, updatedAt: `2026-09-${16 + n}` })),
    messages: taskIds.map((taskId) => ({ taskId, content: `message ${taskId}` })),
  }) as unknown as ProjectDetailResponse;
const detail = (id: string) => ({ task: { id, projectId: id[0] } }) as TaskDetailResponse;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('project and task history selection', () => {
  it('ignores an old project failure after a successful switch', async () => {
    let reject!: (error: Error) => void;
    const old = new Promise<ProjectDetailResponse>((_resolve, fail) => {
      reject = fail;
    });
    const store = new WorkspaceSelection({
      projectDetail: (id) => (id === 'a' ? old : Promise.resolve(project(id, ['b1']))),
      taskDetail: async (id) => detail(id),
    });
    const opening = store.openProject('a');
    await store.openProject('b');
    reject(new Error('old connection failure'));
    await expect(opening).resolves.toBeUndefined();
    expect(store.getSnapshot().taskId).toBe('b1');
  });
  it('loads existing history immediately, restores last viewed task, and reloads the same project', async () => {
    let calls = 0;
    const store = new WorkspaceSelection({
      projectDetail: async (id) => {
        calls++;
        return project(id, [`${id}1`, `${id}2`]);
      },
      taskDetail: async (id) => detail(id),
    });
    await store.openProject('a');
    expect(store.getSnapshot().taskId).toBe('a2');
    expect(store.getSnapshot().project?.messages).toHaveLength(2);
    await store.openTask('a1');
    await store.openProject('b');
    await store.openProject('a');
    expect(store.getSnapshot().taskId).toBe('a1');
    const before = calls;
    await store.openProject('a');
    expect(calls).toBe(before + 1);
    expect(store.getSnapshot().project?.tasks).toHaveLength(2);
    store.newTask();
    await store.refresh();
    expect(store.getSnapshot().taskId).toBeNull();
    expect(store.getSnapshot().project?.tasks).toHaveLength(2);
  });
  it('ignores a slow old project and slow old task after switching', async () => {
    const slowProject = deferred<ProjectDetailResponse>();
    const slowTask = deferred<TaskDetailResponse>();
    const store = new WorkspaceSelection({
      projectDetail: (id) =>
        id === 'a' ? slowProject.promise : Promise.resolve(project(id, [`${id}1`, `${id}2`])),
      taskDetail: (id) => (id === 'b1' ? slowTask.promise : Promise.resolve(detail(id))),
    });
    const oldProject = store.openProject('a');
    await store.openProject('b');
    slowProject.resolve(project('a', ['a1']));
    await oldProject;
    expect(store.getSnapshot().taskId).toBe('b2');
    const oldTask = store.openTask('b1');
    await Promise.resolve();
    await store.openTask('b2');
    slowTask.resolve(detail('b1'));
    await oldTask;
    expect(store.getSnapshot().detail?.task.id).toBe('b2');
  });
  it('does not overwrite a newer refresh and leaves empty projects ready for a new request', async () => {
    const slow = deferred<ProjectDetailResponse>();
    let count = 0;
    const store = new WorkspaceSelection({
      projectDetail: async (id) =>
        ++count === 2 ? slow.promise : project(id, count > 2 ? ['a1', 'a2'] : ['a1']),
      taskDetail: async (id) => detail(id),
    });
    await store.openProject('a');
    const previous = store.refresh();
    await store.refresh();
    slow.resolve(project('a', ['a1']));
    await previous;
    expect(store.getSnapshot().project?.tasks).toHaveLength(2);
    const empty = new WorkspaceSelection({
      projectDetail: async (id) => project(id, []),
      taskDetail: async () => {
        throw new Error('must not fetch a task');
      },
    });
    await empty.openProject('empty');
    expect(empty.getSnapshot()).toMatchObject({ projectId: 'empty', taskId: null, detail: null });
  });
});
