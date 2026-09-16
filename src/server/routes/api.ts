import { z } from 'zod';
import { installHarness, previewHarness } from '../../infrastructure/harness/project-harness.js';
import type { PreflightResult } from '../../shared/project-tools.js';
import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

import type { ZodType } from 'zod';

import type { Orchestrator } from '../../application/orchestrator.js';
import { OrchestrationError } from '../../domain/errors.js';
import type { ProjectId, TaskId } from '../../domain/ids.js';
import {
  ClarificationAnswerBody,
  RegisterProjectBody,
  RejectTaskBody,
  SubmitRequestBody,
  type ProjectDetailResponse,
  type RuntimeStatusResponse,
  type TaskDetailResponse,
  toPublicRun,
  toPublicTask,
  toPublicTaskEvent,
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
  runtimeStatus: RuntimeStatusResponse;
  preflight?: (root: string) => Promise<PreflightResult>;
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
    const root = realpathSync.native(resolve(input));
    if (!statSync(root).isDirectory()) throw new Error('not directory');
    return root;
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
  const { method, path, body, orchestrator, ids, runtimeStatus } = req;
  const seg = path.split('/').filter(Boolean); // ['api', ...]

  if (seg[1] === 'runtime-status' && seg.length === 2 && method === 'GET') {
    return { status: 200, body: runtimeStatus };
  }

  if (seg[1] === 'projects' && seg.length === 4 && seg[2]) {
    const project = orchestrator.listProjects().find((p) => p.id === ids.asProjectId(seg[2]!));
    if (!project) throw new OrchestrationError('PROJECT_NOT_FOUND', '프로젝트를 찾을 수 없습니다.');
    if (seg[3] === 'harness' && method === 'GET')
      return { status: 200, body: previewHarness(project.rootPath) };
    if (seg[3] === 'harness' && method === 'POST') {
      parse(z.object({ confirm: z.literal(true) }).strict(), body);
      return { status: 200, body: installHarness(project.rootPath) };
    }
    if (seg[3] === 'preflight' && method === 'POST' && req.preflight)
      return { status: 200, body: await req.preflight(project.rootPath) };
  }
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
        tasks: orchestrator.listTasks(id).map(toPublicTask),
        messages: orchestrator.listMessages(id),
        usage: orchestrator.projectUsage(id),
      };
      return { status: 200, body: res };
    }
  }

  if (seg[1] === 'requests' && seg.length === 2 && method === 'POST') {
    const input = parse(SubmitRequestBody, body);
    const task = await orchestrator.submitRequest(
      ids.asProjectId(input.projectId),
      input.request,
      input.executionLimits,
    );
    // Planning runs in the background; the client follows progress over SSE.
    return { status: 202, body: { task: toPublicTask(task) } };
  }

  if (seg[1] === 'tasks' && seg[2]) {
    const id = ids.asTaskId(seg[2]);
    if (seg.length === 3 && method === 'GET') {
      const res: TaskDetailResponse = {
        task: toPublicTask(orchestrator.getTask(id)),
        runs: orchestrator.listRuns(id).map(toPublicRun),
        timeline: orchestrator.listTimeline(id).map(toPublicTaskEvent),
        usage: orchestrator.taskUsage(id),
        budget: orchestrator.budgetStatus(id),
      };
      return { status: 200, body: res };
    }
    if (seg.length === 4 && method === 'POST') {
      switch (seg[3]) {
        case 'delete':
          parse(z.object({ confirm: z.literal(true) }).strict(), body);
          orchestrator.deleteTaskHistory(id);
          return { status: 200, body: { deleted: true } };
        case 'approve':
          return { status: 200, body: { task: toPublicTask(orchestrator.approve(id)) } };
        case 'clarify': {
          const input = parse(ClarificationAnswerBody, body);
          return {
            status: 202,
            body: { task: toPublicTask(orchestrator.answerClarification(id, input.answer)) },
          };
        }
        case 'reject': {
          const input = parse(RejectTaskBody, body);
          return {
            status: 200,
            body: { task: toPublicTask(orchestrator.reject(id, input.reason)) },
          };
        }
        case 'cancel':
          return {
            status: 200,
            body: { task: toPublicTask(await orchestrator.cancel(id)) },
          };
      }
    }
  }

  throw new HttpError(404, 'NOT_FOUND', `No route for ${method} ${path}.`);
}
