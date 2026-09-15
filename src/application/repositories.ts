import type { ProjectId, RunId, TaskId } from '../domain/ids.js';
import type { Message, TaskEvent } from '../domain/message.js';
import type { Project } from '../domain/project.js';
import type { Run } from '../domain/run.js';
import type { Task } from '../domain/task.js';
import type { UsageRecord } from '../domain/usage.js';

// Repository ports. Implemented in-memory (tests) and with SQLite (runtime).
// All methods are synchronous by design: SQLite via node:sqlite is sync and
// the orchestrator never needs to await storage.

export interface ProjectRepository {
  insert(project: Project): void;
  findById(id: ProjectId): Project | null;
  list(): Project[];
}

export interface TaskRepository {
  insert(task: Task): void;
  update(task: Task): void;
  findById(id: TaskId): Task | null;
  listByProject(projectId: ProjectId): Task[];
  listAll(): Task[];
}

export interface RunRepository {
  insert(run: Run): void;
  update(run: Run): void;
  findById(id: RunId): Run | null;
  listByTask(taskId: TaskId): Run[];
}

export interface MessageRepository {
  insert(message: Message): void;
  listByProject(projectId: ProjectId): Message[];
}

export interface UsageRepository {
  insert(record: UsageRecord): void;
  listByTask(taskId: TaskId): UsageRecord[];
  listByProject(projectId: ProjectId): UsageRecord[];
}

export interface TaskEventRepository {
  insert(event: TaskEvent): void;
  listByTask(taskId: TaskId): TaskEvent[];
}

export interface Repositories {
  projects: ProjectRepository;
  tasks: TaskRepository;
  runs: RunRepository;
  messages: MessageRepository;
  usage: UsageRepository;
  taskEvents: TaskEventRepository;
}
