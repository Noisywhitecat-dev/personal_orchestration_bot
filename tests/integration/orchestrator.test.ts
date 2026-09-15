import { describe, expect, it } from 'vitest';

import { type OrchestrationEvent } from '../../src/application/events.js';
import { Orchestrator } from '../../src/application/orchestrator.js';
import { OrchestrationError } from '../../src/domain/errors.js';
import type { ProjectId } from '../../src/domain/ids.js';
import { FixedClock, SequentialIdGenerator } from '../../src/domain/ports.js';
import { FakeClaudeAdapter } from '../../src/infrastructure/agents/fake-claude-adapter.js';
import { FakeCodexAdapter } from '../../src/infrastructure/agents/fake-codex-adapter.js';
import { createInMemoryRepositories } from '../../src/infrastructure/persistence/in-memory-repositories.js';

/** Submit a request and wait for background planning to settle. */
async function submitAndPlan(o: Orchestrator, projectId: ProjectId, request: string) {
  const draft = await o.submitRequest(projectId, request);
  await o.whenSettled(draft.id);
  return o.getTask(draft.id);
}

function setup(opts: { changeRequestsBeforeApprove?: number; maxReviewRounds?: number } = {}) {
  const clock = new FixedClock();
  const ids = new SequentialIdGenerator();
  const repos = createInMemoryRepositories();
  const claude = new FakeClaudeAdapter(clock, ids, {
    ...(opts.changeRequestsBeforeApprove !== undefined
      ? { changeRequestsBeforeApprove: opts.changeRequestsBeforeApprove }
      : {}),
  });
  const codex = new FakeCodexAdapter(clock, ids);
  const orchestrator = new Orchestrator({
    clock,
    ids,
    claude,
    codex,
    repos,
    ...(opts.maxReviewRounds !== undefined ? { maxReviewRounds: opts.maxReviewRounds } : {}),
  });
  const events: OrchestrationEvent[] = [];
  orchestrator.bus.subscribe((e) => events.push(e));
  const project = orchestrator.registerProject('demo', 'D:/fake/demo');
  return { orchestrator, repos, project, events };
}

describe('Orchestrator: plan + approval', () => {
  it('produces a plan and waits for approval', async () => {
    const { orchestrator, project } = setup();
    const draft = await orchestrator.submitRequest(project.id, 'Add a logout button');
    expect(draft.state).toBe('draft');
    expect(draft.plan).toBeNull();
    await orchestrator.whenSettled(draft.id);
    const task = orchestrator.getTask(draft.id);
    expect(task.state).toBe('awaiting_approval');
    expect(task.plan?.steps).toHaveLength(3);
    expect(task.claudeSessionId).not.toBeNull();
    expect(orchestrator.listRuns(task.id)).toHaveLength(1);
    expect(orchestrator.taskUsage(task.id).claude.totalTokens).toBe(200);
    expect(orchestrator.taskUsage(task.id).codex.totalTokens).toBeNull();
  });

  it('rejects → cancelled and never runs codex', async () => {
    const { orchestrator, project } = setup();
    const task = await submitAndPlan(orchestrator, project.id, 'Add a logout button');
    const rejected = orchestrator.reject(task.id, 'not now');
    expect(rejected.state).toBe('cancelled');
    await orchestrator.whenSettled(task.id);
    expect(orchestrator.listRuns(task.id).map((r) => r.provider)).toEqual(['claude']);
  });

  it('cannot approve twice', async () => {
    const { orchestrator, project } = setup();
    const task = await submitAndPlan(orchestrator, project.id, 'x');
    orchestrator.approve(task.id);
    expect(() => orchestrator.approve(task.id)).toThrow(OrchestrationError);
    await orchestrator.whenSettled(task.id);
  });
});

describe('Orchestrator: implementation + review loop', () => {
  it('completes on first review approval', async () => {
    const { orchestrator, project, events } = setup();
    const task = await submitAndPlan(orchestrator, project.id, 'Add a logout button');
    orchestrator.approve(task.id);
    await orchestrator.whenSettled(task.id);

    const final = orchestrator.getTask(task.id);
    expect(final.state).toBe('completed');
    expect(final.reviewRound).toBe(1);
    expect(final.reviews[0]?.verdict).toBe('approve');
    expect(final.codexSessionId).not.toBeNull();

    const runs = orchestrator.listRuns(task.id);
    expect(runs.map((r) => `${r.provider}:${r.kind}:${r.status}`)).toEqual([
      'claude:plan:completed',
      'codex:implement:completed',
      'claude:review:completed',
    ]);

    const states = events
      .filter(
        (e): e is Extract<OrchestrationEvent, { type: 'task_updated' }> =>
          e.type === 'task_updated',
      )
      .map((e) => e.task.state);
    expect(states).toContain('queued');
    expect(states).toContain('implementing');
    expect(states).toContain('review_requested');
    expect(states).toContain('reviewing');
    expect(states).toContain('approved');
    expect(states[states.length - 1]).toBe('completed');

    const usage = orchestrator.taskUsage(task.id);
    expect(usage.claude.totalTokens).toBe(560); // 200 actual + 360 estimated
    expect(usage.claude.hasEstimated).toBe(true);
    expect(usage.codex.totalTokens).toBe(1300);
    expect(usage.codex.hasEstimated).toBe(false);
  });

  it('runs one revision round and reuses the codex session', async () => {
    const { orchestrator, project } = setup({ changeRequestsBeforeApprove: 1 });
    const task = await submitAndPlan(orchestrator, project.id, 'Add a logout button');
    orchestrator.approve(task.id);
    await orchestrator.whenSettled(task.id);

    const final = orchestrator.getTask(task.id);
    expect(final.state).toBe('completed');
    expect(final.reviewRound).toBe(2);
    expect(final.reviews.map((r) => r.verdict)).toEqual(['request_changes', 'approve']);

    const codexRuns = orchestrator.listRuns(task.id).filter((r) => r.provider === 'codex');
    expect(codexRuns.map((r) => r.kind)).toEqual(['implement', 'revise']);
    expect(new Set(codexRuns.map((r) => r.sessionId)).size).toBe(1);

    expect(orchestrator.taskUsage(task.id).codex.totalTokens).toBe(1300 + 750);
  });

  it('fails with REVIEW_ROUNDS_EXCEEDED when the limit is hit', async () => {
    const { orchestrator, project } = setup({
      changeRequestsBeforeApprove: 10,
      maxReviewRounds: 2,
    });
    const task = await submitAndPlan(orchestrator, project.id, 'Add a logout button');
    orchestrator.approve(task.id);
    await orchestrator.whenSettled(task.id);

    const final = orchestrator.getTask(task.id);
    expect(final.state).toBe('failed');
    expect(final.failure?.code).toBe('REVIEW_ROUNDS_EXCEEDED');
    expect(final.reviewRound).toBe(2);
    // implement + revise once, then the second review exceeded the limit.
    expect(orchestrator.listRuns(task.id).filter((r) => r.provider === 'codex')).toHaveLength(2);
    const sys = orchestrator.listMessages(project.id).filter((m) => m.role === 'system');
    expect(sys.some((m) => m.content.includes('REVIEW_ROUNDS_EXCEEDED'))).toBe(true);
  });

  it('prompt marker overrides review behaviour per task', async () => {
    const { orchestrator, project } = setup();
    const task = await submitAndPlan(orchestrator, project.id, 'Add a button [fake-changes:1]');
    orchestrator.approve(task.id);
    await orchestrator.whenSettled(task.id);
    expect(orchestrator.getTask(task.id).reviews.map((r) => r.verdict)).toEqual([
      'request_changes',
      'approve',
    ]);
  });

  it('fails the task when codex fails', async () => {
    const { orchestrator, project } = setup();
    const task = await submitAndPlan(orchestrator, project.id, 'Do the thing [fake-fail]');
    orchestrator.approve(task.id);
    await orchestrator.whenSettled(task.id);
    const final = orchestrator.getTask(task.id);
    expect(final.state).toBe('failed');
    expect(final.failure?.code).toBe('IMPLEMENTATION_FAILED');
    expect(orchestrator.listRuns(task.id).at(-1)?.status).toBe('failed');
  });
});

describe('Orchestrator: timeline and recovery', () => {
  it('records a bounded timeline', async () => {
    const { orchestrator, project } = setup();
    const task = await submitAndPlan(orchestrator, project.id, 'x');
    orchestrator.approve(task.id);
    await orchestrator.whenSettled(task.id);
    const types = orchestrator.listTimeline(task.id).map((e) => e.type);
    expect(types).toContain('state_changed');
    expect(types).toContain('command_started');
    expect(types).toContain('usage_reported');
    expect(types).toContain('agent_message');
    expect(types).not.toContain('message_delta');
  });

  it('recoverInterrupted fails mid-run tasks and restarts queued ones', async () => {
    const { orchestrator, repos, project } = setup();
    const t1 = await submitAndPlan(orchestrator, project.id, 'one');
    const t2 = await submitAndPlan(orchestrator, project.id, 'two');
    const t3 = await submitAndPlan(orchestrator, project.id, 'three');
    const t4 = await submitAndPlan(orchestrator, project.id, 'four');
    // Simulate persisted state from a crashed process.
    repos.tasks.update({ ...orchestrator.getTask(t1.id), state: 'implementing' });
    repos.tasks.update({ ...orchestrator.getTask(t2.id), state: 'queued' });
    repos.tasks.update({ ...orchestrator.getTask(t3.id), state: 'draft' });
    const planRun = orchestrator.listRuns(t3.id)[0];
    if (!planRun) throw new Error('no plan run');
    repos.runs.update({ ...planRun, status: 'running', finishedAt: null });
    // t4 stays awaiting_approval.

    const result = orchestrator.recoverInterrupted();
    expect(result.failed).toEqual([t1.id, t3.id]);
    expect(result.restarted).toEqual([t2.id]);
    expect(orchestrator.getTask(t1.id).failure?.code).toBe('INTERRUPTED');
    expect(orchestrator.getTask(t3.id).state).toBe('failed');
    expect(orchestrator.getTask(t3.id).failure?.code).toBe('INTERRUPTED');
    const closed = orchestrator.listRuns(t3.id)[0];
    expect(closed?.status).toBe('failed');
    expect(closed?.finishedAt).not.toBeNull();
    expect(orchestrator.getTask(t4.id).state).toBe('awaiting_approval');
    // Running it again touches nothing.
    expect(orchestrator.recoverInterrupted()).toEqual({ restarted: [], failed: [] });

    await orchestrator.whenSettled(t2.id);
    expect(orchestrator.getTask(t2.id).state).toBe('completed');
  });
});
