import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  Project,
  ProjectDetailResponse,
  RuntimeStatusResponse,
  SseEvent,
  Task,
  TaskDetailResponse,
  ExecutionLimitsInput,
} from '../../shared/contracts.js';
import { api } from '../api.js';
import { errorGuidance } from '../view-model.js';
import { useEvents } from './useEvents.js';

export function useWorkspace() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [taskId, setTaskId] = useState<string | null>(null);
  const [project, setProject] = useState<ProjectDetailResponse | null>(null);
  const [detail, setDetail] = useState<TaskDetailResponse | null>(null);
  const [runtime, setRuntime] = useState<RuntimeStatusResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const selected = useRef({ projectId, taskId });
  selected.current = { projectId, taskId };
  const loading = useRef(0);
  const requestVersion = useRef(0);
  const newTask = useCallback(() => {
    setTaskId(null);
    setDetail(null);
  }, []);

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

  const reload = useCallback(async () => {
    const selection = { ...selected.current };
    const version = ++requestVersion.current;
    const [nextProject, nextDetail] = await Promise.all([
      selection.projectId ? api.projectDetail(selection.projectId) : null,
      selection.taskId ? api.taskDetail(selection.taskId) : null,
    ]);
    if (
      version !== requestVersion.current ||
      selection.projectId !== selected.current.projectId ||
      selection.taskId !== selected.current.taskId
    )
      return;
    if (nextProject) setProject(nextProject);
    if (nextDetail)
      setDetail((current) =>
        current &&
        current.task.id === nextDetail.task.id &&
        current.task.updatedAt > nextDetail.task.updatedAt
          ? current
          : nextDetail,
      );
  }, []);

  useEffect(() => {
    void act(async () => {
      const [list, status] = await Promise.all([api.listProjects(), api.runtimeStatus()]);
      setProjects(list);
      setRuntime(status);
      if (list[0]) setProjectId(list[0].id);
    });
  }, [act]);
  useEffect(() => {
    void act(reload);
  }, [projectId, taskId, act, reload]);
  const onEvent = useCallback((event: SseEvent) => {
    if (event.type === 'task_updated' && event.task.projectId === selected.current.projectId) {
      setProject((current) =>
        current
          ? {
              ...current,
              tasks: [...current.tasks.filter((t) => t.id !== event.task.id), event.task].sort(
                (a, b) => a.createdAt.localeCompare(b.createdAt),
              ),
            }
          : current,
      );
      if (event.task.id === selected.current.taskId)
        setDetail((current) =>
          current && current.task.updatedAt <= event.task.updatedAt
            ? { ...current, task: event.task }
            : current,
        );
    }
    // Coalesced REST refresh below carries messages, usage, budget and event metadata together.
    scheduleRefresh();
    // scheduleRefresh closes over stable reload; timer cleanup is below.
  }, []);
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
    setProjectId(id);
    setTaskId(null);
    setProject(null);
    setDetail(null);
  };
  const selectTask = (id: string) => {
    setTaskId(id);
    setDetail(null);
  };
  const register = async (name: string, rootPath: string) =>
    act(async () => {
      const created = await api.registerProject({ name, rootPath });
      setProjects(await api.listProjects());
      selectProject(created.id);
    });
  const submit = async (text: string, limits: ExecutionLimitsInput) => {
    if (!projectId) return false;
    return act(async () => {
      const task = await api.submitRequestWithLimits(projectId, text, limits);
      selectTask(task.id);
    });
  };
  const taskAction = (action: 'approve' | 'reject' | 'cancel' | 'clarify', answer = '') =>
    act(async () => {
      if (!taskId) return;
      const updated: Task =
        action === 'clarify' ? await api.clarify(taskId, answer) : await api[action](taskId);
      setDetail((current) => (current ? { ...current, task: updated } : current));
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
    act,
    reload,
  };
}
