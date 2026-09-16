import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type {
  Project,
  RuntimeStatusResponse,
  SseEvent,
  ExecutionLimitsInput,
} from '../../shared/contracts.js';
import { api } from '../api.js';
import { errorGuidance } from '../view-model.js';
import { WorkspaceSelection } from '../workspace-selection.js';
import { useEvents } from './useEvents.js';

export function useWorkspace() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [selection] = useState(() => new WorkspaceSelection(api));
  const { projectId, taskId, project, detail } = useSyncExternalStore(
    selection.subscribe,
    selection.getSnapshot,
  );
  const [runtime, setRuntime] = useState<RuntimeStatusResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const loading = useRef(0);
  const newTask = () => {
    void act(() => selection.newTask());
  };

  const act = useCallback(async (fn: () => Promise<unknown>): Promise<boolean> => {
    loading.current += 1;
    setBusy(true);
    setError('');
    try {
      await fn();
      return true;
    } catch (err) {
      setError(errorGuidance(err));
      return false;
    } finally {
      loading.current -= 1;
      setBusy(loading.current > 0);
    }
  }, []);

  const reload = useCallback(() => selection.refresh(), [selection]);
  useEffect(() => {
    let active = true;
    void act(async () => {
      const [list, status] = await Promise.all([api.listProjects(), api.runtimeStatus()]);
      if (!active) return;
      setProjects(list);
      setRuntime(status);
      if (list[0]) await selection.openProject(list[0].id);
    });
    return () => {
      active = false;
    };
  }, [act, selection]);
  const onEvent = (event: SseEvent) => {
    if ('projectId' in event && event.projectId !== selection.getSnapshot().projectId) return;
    scheduleRefresh();
  };
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  function scheduleRefresh() {
    if (timer.current) return;
    timer.current = setTimeout(() => {
      timer.current = null;
      void reload().catch(() =>
        setError('연결을 복구하려면 새로 고침하세요. 자동 AI 재실행은 하지 않습니다.'),
      );
    }, 80);
  }
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  useEvents(onEvent, () => {
    void reload().catch(() => setError('서버 연결을 확인하고 새로 고침하세요.'));
  });

  const selectProject = (id: string) => {
    void act(() => selection.openProject(id));
  };
  const selectTask = (id: string) => {
    void act(() => selection.openTask(id));
  };
  const register = async (name: string, rootPath: string) =>
    act(async () => {
      const created = await api.registerProject({ name, rootPath });
      setProjects(await api.listProjects());
      await selection.openProject(created.id);
    });
  const submit = async (text: string, limits: ExecutionLimitsInput) => {
    if (!projectId) return false;
    return act(async () => {
      const task = await api.submitRequestWithLimits(projectId, text, limits);
      if (selection.getSnapshot().projectId === projectId) await selection.openTask(task.id);
    });
  };
  const taskAction = (action: 'approve' | 'reject' | 'cancel' | 'clarify', answer = '') =>
    act(async () => {
      if (!taskId) return;
      if (action === 'clarify') await api.clarify(taskId, answer);
      else await api[action](taskId);
      await reload();
    });
  return {
    projects,
    projectId,
    taskId,
    project,
    detail,
    runtime,
    busy,
    error,
    setError,
    selectProject,
    selectTask,
    newTask,
    register,
    submit,
    taskAction,
    deleteTask: (id: string) =>
      act(async () => {
        await api.deleteTask(id);
        await reload();
      }),
    act,
    reload,
  };
}
