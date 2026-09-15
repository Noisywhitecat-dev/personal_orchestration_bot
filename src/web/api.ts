import type {
  ApiError,
  Project,
  ProjectDetailResponse,
  RegisterProjectBody,
  RuntimeStatusResponse,
  Task,
  TaskDetailResponse,
  ExecutionLimitsInput,
} from '../shared/contracts.js';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  const body = (await res.json()) as T | ApiError;
  if (!res.ok) {
    const err = body as ApiError;
    throw new Error(`${err.error?.code ?? res.status}: ${err.error?.message ?? 'request failed'}`);
  }
  return body as T;
}

const post = <T>(path: string, body?: unknown): Promise<T> =>
  request<T>(path, { method: 'POST', body: body === undefined ? null : JSON.stringify(body) });

export const api = {
  listProjects: () => request<{ projects: Project[] }>('/api/projects').then((r) => r.projects),
  registerProject: (body: RegisterProjectBody) =>
    post<{ project: Project }>('/api/projects', body).then((r) => r.project),
  projectDetail: (id: string) => request<ProjectDetailResponse>(`/api/projects/${id}`),
  submitRequest: (projectId: string, text: string) =>
    post<{ task: Task }>('/api/requests', { projectId, request: text }).then((r) => r.task),
  submitRequestWithLimits: (
    projectId: string,
    text: string,
    executionLimits: ExecutionLimitsInput,
  ) =>
    post<{ task: Task }>('/api/requests', { projectId, request: text, executionLimits }).then(
      (r) => r.task,
    ),
  taskDetail: (id: string) => request<TaskDetailResponse>(`/api/tasks/${id}`),
  runtimeStatus: () => request<RuntimeStatusResponse>('/api/runtime-status'),
  approve: (id: string) => post<{ task: Task }>(`/api/tasks/${id}/approve`).then((r) => r.task),
  clarify: (id: string, answer: string) =>
    post<{ task: Task }>(`/api/tasks/${id}/clarify`, { answer }).then((r) => r.task),
  reject: (id: string, reason?: string) =>
    post<{ task: Task }>(`/api/tasks/${id}/reject`, { reason }).then((r) => r.task),
  cancel: (id: string) => post<{ task: Task }>(`/api/tasks/${id}/cancel`).then((r) => r.task),
};
