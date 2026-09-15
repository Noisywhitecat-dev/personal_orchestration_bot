import { realpathSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

import type { ZodType } from 'zod';

import type { Orchestrator } from '../../application/orchestrator.js';
import { OrchestrationError } from '../../domain/errors.js';
import type { ProjectId, TaskId } from '../../domain/ids.js';
import {
  RegisterProjectBody,
  RejectTaskBody,
  SubmitRequestBody,
  type ProjectDetailResponse,
  type TaskDetailResponse,
} from '../../shared/contracts.js';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export interface ApiRequest {
  method: string;
  path: string;
  body: unknown;
  orchestrator: Orchestrator;
  ids: { asProjectId: (s: string) => ProjectId; asTaskId: (s: string) => TaskId };
}

export interface ApiResult {
  status: number;
  body: unknown;
}

function parse<T>(schema: ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body);
  if (!r.success) {
    const issue = r.error.issues[0];
    throw new HttpError(
      400,
      'VALIDATION_FAILED',
      issue ? `${issue.path.join('.') || 'body'}: ${issue.message}` : 'Invalid body.',
    );
  }
  return r.data;
}

/** Resolve to a canonical absolute path and require it to exist as a directory. */
export function canonicalProjectRoot(input: string): string {
  if (!isAbsolute(input)) {
    throw new OrchestrationError('INVALID_PROJECT_ROOT', 'Project root must be an absolute path.');
  }
  try {
    return realpathSync.native(resolve(input));
  } catch {
    throw new OrchestrationError(
      'INVALID_PROJECT_ROOT',
      'Project root does not exist or is not accessible.',
    );
  }
}

/**
 * Routes:
 *   GET  /api/projects
 *   POST /api/projects                    { name, rootPath }
 *   GET  /api/projects/:id                → ProjectDetailResponse
 *   POST /api/requests                    { projectId, request } → 202 + draft task (planning is async)
 *   GET  /api/tasks/:id                   → TaskDetailResponse
 *   POST /api/tasks/:id/approve
 *   POST /api/tasks/:id/reject            { reason? }
 *   POST /api/tasks/:id/cancel
 *   GET  /api/events                      (SSE, handled in app.ts)
 */
export async function handleApi(req: ApiRequest): Promise<ApiResult> {
  const { method, path, body, orchestrator, ids } = req;
  const seg = path.split('/').filter(Boolean); // ['api', ...]

  if (seg[1] === 'projects') {
    if (seg.length === 2 && method === 'GET') {
      return { status: 200, body: { projects: orchestrator.listProjects() } };
    }
    if (seg.length === 2 && method === 'POST') {
      const input = parse(RegisterProjectBody, body);
      const root = canonicalProjectRoot(input.rootPath);
      return { status: 201, body: { project: orchestrator.registerProject(input.name, root) } };
    }
    if (seg.length === 3 && seg[2] && method === 'GET') {
      const id = ids.asProjectId(seg[2]);
      const project = orchestrator.listProjects().find((p) => p.id === id);
      if (!project) throw new OrchestrationError('PROJECT_NOT_FOUND', 'Project not found.');
      const res: ProjectDetailResponse = {
        project,
        tasks: orchestrator.listTasks(id),
        messages: orchestrator.listMessages(id),
        usage: orchestrator.projectUsage(id),
      };
      return { status: 200, body: res };
    }
  }

  if (seg[1] === 'requests' && seg.length === 2 && method === 'POST') {
    const input = parse(SubmitRequestBody, body);
    const task = await orchestrator.submitRequest(ids.asProjectId(input.projectId), input.request);
    // Planning runs in the background; the client follows progress over SSE.
    return { status: 202, body: { task } };
  }

  if (seg[1] === 'tasks' && seg[2]) {
    const id = ids.asTaskId(seg[2]);
    if (seg.length === 3 && method === 'GET') {
      const res: TaskDetailResponse = {
        task: orchestrator.getTask(id),
        runs: orchestrator.listRuns(id),
        timeline: orchestrator.listTimeline(id),
        usage: orchestrator.taskUsage(id),
      };
      return { status: 200, body: res };
    }
    if (seg.length === 4 && method === 'POST') {
      switch (seg[3]) {
        case 'approve':
          return { status: 200, body: { task: orchestrator.approve(id) } };
        case 'reject': {
          const input = parse(RejectTaskBody, body);
          return { status: 200, body: { task: orchestrator.reject(id, input.reason) } };
        }
        case 'cancel':
          return { status: 200, body: { task: await orchestrator.cancel(id) } };
      }
    }
  }

  throw new HttpError(404, 'NOT_FOUND', `No route for ${method} ${path}.`);
}
