import type { Repositories } from '../../application/repositories.js';
import type { ProjectId, RunId, TaskId } from '../../domain/ids.js';
import type { Message, TaskEvent } from '../../domain/message.js';
import type { Project } from '../../domain/project.js';
import type { Run } from '../../domain/run.js';
import type { Task } from '../../domain/task.js';
import type { UsageRecord } from '../../domain/usage.js';

/** Test/dev implementation. Stores deep copies so callers cannot mutate stored state. */
export function createInMemoryRepositories(): Repositories {
  const projects = new Map<ProjectId, Project>();
  const tasks = new Map<TaskId, Task>();
  const runs = new Map<RunId, Run>();
  const messages: Message[] = [];
  const usage: UsageRecord[] = [];
  const events: TaskEvent[] = [];

  const clone = <T>(v: T): T => structuredClone(v);

  return {
    projects: {
      insert: (p) => void projects.set(p.id, clone(p)),
      findById: (id) => clone(projects.get(id) ?? null),
      list: () => [...projects.values()].map(clone),
    },
    tasks: {
      insert: (t) => void tasks.set(t.id, clone(t)),
      update: (t) => {
        if (!tasks.has(t.id)) throw new Error(`task ${t.id} not found`);
        tasks.set(t.id, clone(t));
      },
      findById: (id) => clone(tasks.get(id) ?? null),
      listByProject: (pid) => [...tasks.values()].filter((t) => t.projectId === pid).map(clone),
      listAll: () => [...tasks.values()].map(clone),
    },
    runs: {
      insert: (r) => void runs.set(r.id, clone(r)),
      update: (r) => {
        if (!runs.has(r.id)) throw new Error(`run ${r.id} not found`);
        runs.set(r.id, clone(r));
      },
      findById: (id) => clone(runs.get(id) ?? null),
      listByTask: (tid) => [...runs.values()].filter((r) => r.taskId === tid).map(clone),
    },
    messages: {
      insert: (m) => void messages.push(clone(m)),
      listByProject: (pid) => messages.filter((m) => m.projectId === pid).map(clone),
    },
    usage: {
      insert: (u) => void usage.push(clone(u)),
      listByTask: (tid) => usage.filter((u) => u.taskId === tid).map(clone),
      listByProject: (pid) => usage.filter((u) => u.projectId === pid).map(clone),
    },
    taskEvents: {
      insert: (e) => void events.push(clone(e)),
      listByTask: (tid) => events.filter((e) => e.taskId === tid).map(clone),
    },
  };
}
