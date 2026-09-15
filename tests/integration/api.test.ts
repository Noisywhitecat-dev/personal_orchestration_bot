import { mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Orchestrator } from '../../src/application/orchestrator.js';
import { FixedClock, SequentialIdGenerator } from '../../src/domain/ports.js';
import type { Task } from '../../src/domain/task.js';
import { FakeClaudeAdapter } from '../../src/infrastructure/agents/fake-claude-adapter.js';
import { FakeCodexAdapter } from '../../src/infrastructure/agents/fake-codex-adapter.js';
import { createInMemoryRepositories } from '../../src/infrastructure/persistence/in-memory-repositories.js';
import { createApp } from '../../src/server/app.js';
import { toPublicTaskEvent } from '../../src/shared/contracts.js';
import type {
  ProjectDetailResponse,
  RuntimeStatusResponse,
  TaskEvent,
  TaskDetailResponse,
} from '../../src/shared/contracts.js';
import { GatedAdapter } from '../helpers/gated-adapter.js';

let server: Server;
let base: string;
let orchestrator: Orchestrator;
let claude: GatedAdapter;
let projectDir: string;

beforeAll(async () => {
  projectDir = mkdtempSync(join(tmpdir(), 'orch-proj-'));
  const clock = new FixedClock();
  const ids = new SequentialIdGenerator();
  claude = new GatedAdapter(new FakeClaudeAdapter(clock, ids), ['plan']);
  orchestrator = new Orchestrator({
    clock,
    ids,
    claude,
    codex: new FakeCodexAdapter(clock, ids),
    repos: createInMemoryRepositories(),
  });
  server = createApp({ orchestrator });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no address');
  base = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(projectDir, { recursive: true, force: true });
});

async function post<T>(path: string, body?: unknown): Promise<{ status: number; body: T }> {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? null : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as T };
}

async function get<T>(path: string): Promise<{ status: number; body: T }> {
  const res = await fetch(base + path);
  return { status: res.status, body: (await res.json()) as T };
}

describe('HTTP API', () => {
  it('redacts a legacy timeline session id at the public boundary', () => {
    const legacy = {
      id: 'event',
      taskId: 'task',
      runId: 'run',
      type: 'session_started',
      payload: { sessionId: 'must-not-leak' },
      createdAt: '2026-09-16T00:00:00.000Z',
    } as unknown as TaskEvent;
    expect(toPublicTaskEvent(legacy).payload).toEqual({ sessionPresent: true });

    const legacyCommand = {
      ...legacy,
      type: 'command_completed',
      payload: { commandId: 'command', exitCode: 0, stdoutTail: 'diff body', stderrTail: '' },
    };
    expect(toPublicTaskEvent(legacyCommand).payload).toEqual({
      commandId: 'command',
      exitCode: 0,
      stdoutPresent: true,
      stderrPresent: false,
    });
  });

  it('reports token-free runtime status without private paths or secrets', async () => {
    const status = await get<RuntimeStatusResponse>('/api/runtime-status');
    expect(status.status).toBe(200);
    expect(status.body).toMatchObject({
      claude: { adapter: 'fake', executable: 'not_required' },
      codex: { adapter: 'fake', executable: 'not_required' },
      database: 'memory',
    });
    const serialized = JSON.stringify(status.body);
    expect(serialized).not.toContain(projectDir);
    expect(serialized).not.toMatch(/session|token.{0,10}(key|secret)|authorization/i);
  });

  it('validates project registration', async () => {
    const bad = await post<{ error: { code: string } }>('/api/projects', {
      name: '',
      rootPath: 'x',
    });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('VALIDATION_FAILED');

    const rel = await post<{ error: { code: string } }>('/api/projects', {
      name: 'a',
      rootPath: 'relative/path',
    });
    expect(rel.status).toBe(400);
    expect(rel.body.error.code).toBe('INVALID_PROJECT_ROOT');

    const missing = await post<{ error: { code: string } }>('/api/projects', {
      name: 'a',
      rootPath: join(projectDir, 'does-not-exist'),
    });
    expect(missing.status).toBe(400);
  });

  it('runs the full flow over HTTP and streams SSE', async () => {
    // Open the SSE stream first so we capture everything.
    const controller = new AbortController();
    const sseRes = await fetch(`${base}/api/events`, { signal: controller.signal });
    expect(sseRes.headers.get('content-type')).toContain('text/event-stream');
    const reader = sseRes.body?.getReader();
    if (!reader) throw new Error('no body');
    let sseText = '';
    const pump = (async () => {
      const dec = new TextDecoder();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        sseText += dec.decode(value, { stream: true });
      }
    })().catch(() => undefined);

    const created = await post<{ project: { id: string } }>('/api/projects', {
      name: 'demo',
      rootPath: projectDir,
    });
    expect(created.status).toBe(201);
    const projectId = created.body.project.id;

    // The planner is parked at a gate, so the response can only arrive if the server does not
    // wait for planning.
    const submitted = await post<{ task: Task }>('/api/requests', {
      projectId,
      request: 'Add a button',
      executionLimits: {
        maxClaudeRuns: 6,
        maxCodexRuns: 3,
        claudeTokenCeiling: null,
        codexTokenCeiling: null,
        maxClarificationRounds: 3,
        maxReviewRounds: 2,
      },
    });
    expect(submitted.status).toBe(202);
    expect(submitted.body.task.state).toBe('draft');
    expect(submitted.body.task.plan).toBeNull();
    const taskId = submitted.body.task.id;
    expect(claude.pending).toBe(1);

    // Still draft while the planner runs; approval is refused.
    const early = await get<TaskDetailResponse>(`/api/tasks/${taskId}`);
    expect(early.body.task.state).toBe('draft');
    expect(early.body.runs.map((r) => `${r.kind}:${r.status}`)).toEqual(['plan:running']);
    const tooEarly = await post<{ error: { code: string } }>(`/api/tasks/${taskId}/approve`);
    expect(tooEarly.status).toBe(409);

    claude.release();
    await orchestrator.whenSettled(taskId as Task['id']);
    const planned = await get<TaskDetailResponse>(`/api/tasks/${taskId}`);
    expect(planned.body.task.state).toBe('awaiting_approval');
    expect(planned.body.task.plan?.steps).toHaveLength(3);

    // Approval gate: reject-then-approve is impossible; approve works once.
    const approved = await post<{ task: Task }>(`/api/tasks/${taskId}/approve`);
    expect(approved.status).toBe(200);
    expect(approved.body.task.state).toBe('queued');
    const again = await post<{ error: { code: string } }>(`/api/tasks/${taskId}/approve`);
    expect(again.status).toBe(409);

    await orchestrator.whenSettled(taskId as Task['id']);

    const detail = await get<TaskDetailResponse>(`/api/tasks/${taskId}`);
    expect(detail.status).toBe(200);
    expect(detail.body.task.state).toBe('completed');
    expect(detail.body.runs).toHaveLength(3);
    expect(detail.body.usage.codex.totalTokens).toBe(1300);
    expect(detail.body.usage.claude.hasEstimated).toBe(true);
    expect(detail.body.budget.claude.usedRuns).toBe(2);
    expect(JSON.stringify(detail.body)).not.toMatch(/SessionId|sessionId/);
    expect(detail.body.timeline.find((event) => event.type === 'session_started')?.payload).toEqual(
      { sessionPresent: true },
    );
    const command = detail.body.timeline.find((event) => event.type === 'command_completed');
    expect(command?.payload).toMatchObject({ exitCode: 0, stdoutPresent: true });
    expect(JSON.stringify(command?.payload)).not.toContain('Tests: 3 passed');

    const proj = await get<ProjectDetailResponse>(`/api/projects/${projectId}`);
    expect(proj.body.tasks).toHaveLength(1);
    expect(proj.body.messages.some((m) => m.role === 'user' && m.content === 'Add a button')).toBe(
      true,
    );
    expect(proj.body.usage.claude.totalTokens).toBe(560);

    // Give the socket a tick to flush, then close the stream.
    await new Promise((r) => setTimeout(r, 20));
    controller.abort();
    await pump;

    const types = [...sseText.matchAll(/^event: (\S+)$/gm)].map((m) => m[1]);
    expect(types).toContain('task_updated');
    expect(types).toContain('timeline_appended');
    expect(types).toContain('usage_updated');
    expect(types).toContain('message_added');
    expect(types).toContain('budget_updated');
    const states = [...sseText.matchAll(/^data: (.*)$/gm)]
      .map((m) => JSON.parse(m[1] ?? '{}') as { type: string; task?: Task })
      .filter((e) => e.type === 'task_updated')
      .map((e) => e.task?.state);
    expect(states[0]).toBe('draft');
    expect(states).toContain('awaiting_approval');
    expect(states.indexOf('draft')).toBeLessThan(states.indexOf('awaiting_approval'));
    expect(states.at(-1)).toBe('completed');
  });

  it('validates execution limits and resumes clarification through the API', async () => {
    const controller = new AbortController();
    const sseRes = await fetch(`${base}/api/events`, { signal: controller.signal });
    const reader = sseRes.body?.getReader();
    if (!reader) throw new Error('no SSE body');
    let sseText = '';
    const pump = (async () => {
      const decoder = new TextDecoder();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        sseText += decoder.decode(value, { stream: true });
      }
    })().catch(() => undefined);

    const created = await post<{ project: { id: string } }>('/api/projects', {
      name: 'clarify-demo',
      rootPath: projectDir,
    });
    const invalid = await post<{ error: { code: string } }>('/api/requests', {
      projectId: created.body.project.id,
      request: 'x',
      executionLimits: {
        maxClaudeRuns: 0,
        maxCodexRuns: 3,
        claudeTokenCeiling: null,
        codexTokenCeiling: null,
        maxClarificationRounds: 3,
        maxReviewRounds: 2,
      },
    });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error.code).toBe('VALIDATION_FAILED');

    const submitted = await post<{ task: Task }>('/api/requests', {
      projectId: created.body.project.id,
      request: 'Need one detail [fake-clarify:1]',
    });
    await claude.waitForPending();
    claude.release();
    await orchestrator.whenSettled(submitted.body.task.id);
    const waiting = await get<TaskDetailResponse>(`/api/tasks/${submitted.body.task.id}`);
    expect(waiting.body.task.state).toBe('awaiting_clarification');

    const answered = await post<{ task: Task }>(`/api/tasks/${submitted.body.task.id}/clarify`, {
      answer: 'Use node:test.',
    });
    expect(answered.status).toBe(202);
    const duplicate = await post<{ error: { code: string } }>(
      `/api/tasks/${submitted.body.task.id}/clarify`,
      { answer: 'duplicate' },
    );
    expect(duplicate.status).toBe(409);
    await claude.waitForPending();
    claude.release();
    await orchestrator.whenSettled(submitted.body.task.id);
    const planned = await get<TaskDetailResponse>(`/api/tasks/${submitted.body.task.id}`);
    expect(planned.body.task.state).toBe('awaiting_approval');
    expect(planned.body.task.hasClaudeSession).toBe(true);
    expect(planned.body.runs.every((run) => !('sessionId' in run))).toBe(true);
    expect(planned.body.timeline.map((event) => event.type)).toEqual(
      expect.arrayContaining(['clarification_requested', 'clarification_answered']),
    );

    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();
    await pump;
    const taskStates = [...sseText.matchAll(/^data: (.*)$/gm)]
      .map((match) => JSON.parse(match[1] ?? '{}') as { type: string; task?: Task })
      .filter((event) => event.type === 'task_updated' && event.task?.id === submitted.body.task.id)
      .map((event) => event.task?.state)
      .filter((state, index, states) => index === 0 || state !== states[index - 1]);
    expect(taskStates).toEqual(['draft', 'awaiting_clarification', 'draft', 'awaiting_approval']);
    expect(sseText).not.toMatch(/SessionId|sessionId/);
  });

  it('cancel during planning over HTTP → cancelled', async () => {
    const created = await post<{ project: { id: string } }>('/api/projects', {
      name: 'demo2',
      rootPath: projectDir,
    });
    const submitted = await post<{ task: Task }>('/api/requests', {
      projectId: created.body.project.id,
      request: 'Cancel me',
    });
    expect(submitted.status).toBe(202);
    await claude.waitForPending();
    const cancelled = await post<{ task: Task }>(`/api/tasks/${submitted.body.task.id}/cancel`);
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.task.state).toBe('cancelled');
    expect(claude.pending).toBe(0);
    const detail = await get<TaskDetailResponse>(`/api/tasks/${submitted.body.task.id}`);
    expect(detail.body.task.state).toBe('cancelled');
    expect(detail.body.runs[0]?.status).toBe('cancelled');
  });

  it('returns 404 for unknown task and route', async () => {
    expect((await get('/api/tasks/nope')).status).toBe(404);
    expect((await get('/api/whatever')).status).toBe(404);
  });
});
