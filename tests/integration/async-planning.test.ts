import { describe, expect, it } from 'vitest';

import type { OrchestrationEvent } from '../../src/application/events.js';
import { Orchestrator } from '../../src/application/orchestrator.js';
import { OrchestrationError } from '../../src/domain/errors.js';
import { FixedClock, SequentialIdGenerator } from '../../src/domain/ports.js';
import { FakeClaudeAdapter } from '../../src/infrastructure/agents/fake-claude-adapter.js';
import { FakeCodexAdapter } from '../../src/infrastructure/agents/fake-codex-adapter.js';
import { createInMemoryRepositories } from '../../src/infrastructure/persistence/in-memory-repositories.js';
import { GatedAdapter } from '../helpers/gated-adapter.js';

// Planning runs in the background. These tests hold the planner at a gate so ordering is
// deterministic: no timers, no real waiting.

function setup() {
  const clock = new FixedClock();
  const ids = new SequentialIdGenerator();
  const repos = createInMemoryRepositories();
  const claude = new GatedAdapter(new FakeClaudeAdapter(clock, ids), ['plan']);
  const orchestrator = new Orchestrator({
    clock,
    ids,
    claude,
    codex: new FakeCodexAdapter(clock, ids),
    repos,
  });
  const events: OrchestrationEvent[] = [];
  orchestrator.bus.subscribe((e) => events.push(e));
  const project = orchestrator.registerProject('demo', 'D:/fake/demo');
  return { orchestrator, claude, repos, project, events };
}

const taskStates = (events: OrchestrationEvent[]) =>
  events
    .filter(
      (e): e is Extract<OrchestrationEvent, { type: 'task_updated' }> => e.type === 'task_updated',
    )
    .map((e) => e.task.state);

describe('background planning', () => {
  it('submitRequest returns the draft before the planner finishes', async () => {
    const { orchestrator, claude, project, events } = setup();
    const draft = await orchestrator.submitRequest(project.id, 'Add a button');

    expect(draft.state).toBe('draft');
    expect(draft.plan).toBeNull();
    expect(orchestrator.getTask(draft.id).state).toBe('draft');
    // The plan run exists and is running; the planner is parked at the gate.
    expect(orchestrator.listRuns(draft.id).map((r) => `${r.kind}:${r.status}`)).toEqual([
      'plan:running',
    ]);
    await claude.waitForPending();
    expect(claude.pending).toBe(1);
    expect(events.some((e) => e.type === 'message_added' && e.message.role === 'user')).toBe(true);
    expect(taskStates(events)).toEqual(['draft']);

    claude.release();
    await orchestrator.whenSettled(draft.id);
    expect(orchestrator.getTask(draft.id).state).toBe('awaiting_approval');
  });

  it('whenSettled right after submitRequest waits for the planning promise', async () => {
    const { orchestrator, claude, project } = setup();
    const draft = await orchestrator.submitRequest(project.id, 'Add a button');
    let settled = false;
    const waiting = orchestrator.whenSettled(draft.id).then(() => {
      settled = true;
    });
    await claude.waitForPending();
    await Promise.resolve();
    expect(settled).toBe(false);
    claude.release();
    await waiting;
    expect(settled).toBe(true);
    expect(orchestrator.getTask(draft.id).state).toBe('awaiting_approval');
  });

  it('success stores plan, session, message and emits task/run/usage events', async () => {
    const { orchestrator, claude, project, events } = setup();
    const draft = await orchestrator.submitRequest(project.id, 'Add a logout button');
    await claude.waitForPending();
    claude.release();
    await orchestrator.whenSettled(draft.id);

    const task = orchestrator.getTask(draft.id);
    expect(task.state).toBe('awaiting_approval');
    expect(task.plan?.title).toBe('Add a logout button');
    expect(task.plan?.steps).toHaveLength(3);
    expect(task.claudeSessionId).not.toBeNull();
    const claudeMsgs = orchestrator.listMessages(project.id).filter((m) => m.role === 'claude');
    expect(claudeMsgs).toHaveLength(1);
    expect(claudeMsgs[0]?.content).toContain(task.plan!.summary);
    expect(orchestrator.listRuns(draft.id)[0]?.status).toBe('completed');
    expect(orchestrator.taskUsage(draft.id).claude.totalTokens).toBe(200);
    expect(taskStates(events)).toEqual(['draft', 'draft', 'draft', 'awaiting_approval']);
    expect(events.filter((e) => e.type === 'usage_updated')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'system_error')).toHaveLength(0);
  });

  it('planner failure → failed with the provider error safely classified', async () => {
    const { orchestrator, claude, project } = setup();
    const draft = await orchestrator.submitRequest(project.id, 'x');
    await claude.waitForPending();
    claude.release({ mode: 'fail', code: 'PLANNER_DOWN', message: 'quota exhausted' });
    await orchestrator.whenSettled(draft.id);
    const task = orchestrator.getTask(draft.id);
    expect(task.state).toBe('failed');
    expect(task.failure?.code).toBe('AGENT_RUN_FAILED');
    expect(task.failure?.message).not.toContain('quota exhausted');
    expect(orchestrator.listRuns(draft.id)[0]?.status).toBe('failed');
  });

  it('planner returns a non-plan result → failed with AGENT_RESULT_INVALID', async () => {
    const { orchestrator, claude, project } = setup();
    const draft = await orchestrator.submitRequest(project.id, 'x');
    await claude.waitForPending();
    claude.release({
      mode: 'result',
      result: { kind: 'review', verdict: 'approve', summary: 'wrong kind', changeRequests: [] },
    });
    await orchestrator.whenSettled(draft.id);
    const task = orchestrator.getTask(draft.id);
    expect(task.state).toBe('failed');
    expect(task.failure?.code).toBe('AGENT_RESULT_INVALID');
  });
});

describe('cancel / reject during planning', () => {
  it('cancel while the planner runs → cancelled, run cancelled, no system_error', async () => {
    const { orchestrator, claude, project, events } = setup();
    const draft = await orchestrator.submitRequest(project.id, 'x');
    await claude.waitForPending();

    const cancelled = await orchestrator.cancel(draft.id);
    expect(cancelled.state).toBe('cancelled');
    expect(claude.pending).toBe(0); // gate observed the abort
    expect(orchestrator.getTask(draft.id).state).toBe('cancelled');
    expect(orchestrator.listRuns(draft.id)[0]?.status).toBe('cancelled');
    expect(events.filter((e) => e.type === 'system_error')).toHaveLength(0);
    expect(taskStates(events).at(-1)).toBe('cancelled');
    // Pipeline registry is clean: a second cancel is rejected by the state rules.
    await expect(orchestrator.cancel(draft.id)).rejects.toBeInstanceOf(OrchestrationError);
  });

  it('reject while the planner runs → cancelled and the planning promise settles', async () => {
    const { orchestrator, claude, project, events } = setup();
    const draft = await orchestrator.submitRequest(project.id, 'x');
    await claude.waitForPending();

    const rejected = orchestrator.reject(draft.id, 'changed my mind');
    expect(rejected.state).toBe('cancelled');
    await orchestrator.whenSettled(draft.id);
    expect(orchestrator.getTask(draft.id).state).toBe('cancelled');
    expect(orchestrator.getTask(draft.id).failure).toBeNull();
    expect(events.filter((e) => e.type === 'system_error')).toHaveLength(0);
    expect(() => orchestrator.reject(draft.id)).toThrow(OrchestrationError);
  });

  it('a late planner result after reject does not change the state', async () => {
    const { orchestrator, repos, project, events } = setup();
    // Planner that ignores the abort signal and completes anyway (worst case adapter).
    const ignoring = new GatedAdapter(
      new FakeClaudeAdapter(new FixedClock(), new SequentialIdGenerator('ig')),
      ['plan'],
    );
    const o2 = new Orchestrator({
      clock: new FixedClock(),
      ids: new SequentialIdGenerator('o2'),
      claude: {
        provider: 'claude',
        start: (input) => ignoring.start({ ...input, signal: new AbortController().signal }),
        resume: (s, input) =>
          ignoring.resume(s, { ...input, signal: new AbortController().signal }),
        cancel: () => Promise.resolve(),
      },
      codex: new FakeCodexAdapter(new FixedClock(), new SequentialIdGenerator('c2')),
      repos,
    });
    o2.bus.subscribe((e) => events.push(e));
    void orchestrator;

    const draft = await o2.submitRequest(project.id, 'late result');
    await ignoring.waitForPending();
    o2.reject(draft.id);
    expect(o2.getTask(draft.id).state).toBe('cancelled');

    // Planner now finishes with a valid plan — it must be ignored.
    ignoring.release();
    await o2.whenSettled(draft.id);
    const task = o2.getTask(draft.id);
    expect(task.state).toBe('cancelled');
    expect(task.plan).toBeNull();
    expect(events.filter((e) => e.type === 'system_error')).toHaveLength(0);
    expect(taskStates(events).filter((s) => s === 'awaiting_approval')).toHaveLength(0);
  });

  it('cancel then a fresh request on the same project works independently', async () => {
    const { orchestrator, claude, project } = setup();
    const a = await orchestrator.submitRequest(project.id, 'a');
    await claude.waitForPending();
    await orchestrator.cancel(a.id);
    const b = await orchestrator.submitRequest(project.id, 'b');
    await claude.waitForPending();
    claude.release();
    await orchestrator.whenSettled(b.id);
    expect(orchestrator.getTask(a.id).state).toBe('cancelled');
    expect(orchestrator.getTask(b.id).state).toBe('awaiting_approval');
  });
});
