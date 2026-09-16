import type { ProjectDetailResponse, TaskDetailResponse } from '../shared/contracts.js';

interface Reader {
  projectDetail(id: string): Promise<ProjectDetailResponse>;
  taskDetail(id: string): Promise<TaskDetailResponse>;
}
interface Snapshot {
  projectId: string | null;
  taskId: string | null;
  project: ProjectDetailResponse | null;
  detail: TaskDetailResponse | null;
}

/** Selection and its data move together. A late response cannot reopen an old selection. */
export class WorkspaceSelection {
  private value: Snapshot = { projectId: null, taskId: null, project: null, detail: null };
  private listeners = new Set<() => void>();
  private lastTask = new Map<string, string>();
  private epoch = 0;
  private request = 0;
  private restoreTask = false;
  constructor(private readonly reader: Reader) {}
  getSnapshot = () => this.value;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish(value: Snapshot) {
    this.value = value;
    for (const listener of this.listeners) listener();
  }
  openProject(id: string) {
    this.epoch++;
    this.restoreTask = true;
    // Refresh even when the project ID has not changed.
    this.publish({ projectId: id, taskId: null, project: null, detail: null });
    return this.refresh();
  }
  openTask(id: string) {
    this.epoch++;
    this.restoreTask = false;
    if (this.value.projectId) this.lastTask.set(this.value.projectId, id);
    this.publish({ ...this.value, taskId: id, detail: null });
    return this.refresh();
  }
  newTask() {
    this.epoch++;
    this.restoreTask = false;
    this.publish({ ...this.value, taskId: null, detail: null });
    return this.refresh();
  }
  async refresh() {
    const { projectId } = this.value;
    if (!projectId) return;
    const epoch = this.epoch;
    const request = ++this.request;
    const current = () => epoch === this.epoch && request === this.request;
    try {
      const project = await this.reader.projectDetail(projectId);
      if (!current()) return;
      let taskId = this.value.taskId;
      if (this.restoreTask) {
        const remembered = this.lastTask.get(projectId);
        const tasks = [...project.tasks].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
        taskId = tasks.find((t) => t.id === remembered)?.id ?? tasks[0]?.id ?? null;
      }
      const detail = taskId ? await this.reader.taskDetail(taskId) : null;
      if (!current()) return;
      if (detail && detail.task.projectId !== projectId)
        throw new Error('작업의 프로젝트가 일치하지 않습니다.');
      this.restoreTask = false;
      if (taskId) this.lastTask.set(projectId, taskId);
      this.publish({ projectId, taskId, project, detail });
    } catch (error) {
      if (current()) throw error;
    }
  }
}
