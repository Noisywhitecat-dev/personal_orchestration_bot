import { describe, expect, it } from 'vitest';

import { Orchestrator } from '../../src/application/orchestrator.js';
import { OrchestrationError } from '../../src/domain/errors.js';
import { FixedClock, SequentialIdGenerator } from '../../src/domain/ports.js';
import { FakeClaudeAdapter } from '../../src/infrastructure/agents/fake-claude-adapter.js';
import { FakeCodexAdapter } from '../../src/infrastructure/agents/fake-codex-adapter.js';
import { createInMemoryRepositories } from '../../src/infrastructure/persistence/in-memory-repositories.js';
import { RecordingAdapter } from '../helpers/recording-adapter.js';

function setup() {
  const clock = new FixedClock();
  const ids = new SequentialIdGenerator();
  const claude = new RecordingAdapter(new FakeClaudeAdapter(clock, ids));
  const codex = new RecordingAdapter(new FakeCodexAdapter(clock, ids));
  const orchestrator = new Orchestrator({
    clock,
    ids,
    claude,
    codex,
    repos: createInMemoryRepositories(),
  });
  const project = orchestrator.registerProject('demo', 'D:/fake/demo');
  return { orchestrator, claude, codex, project };
}

async function submitClarifying(rounds: number, limits = {}) {
  const ctx = setup();
  const task = await ctx.orchestrator.submitRequest(
    ctx.project.id,
    `Build a tiny thing [fake-clarify:${rounds}]`,
    limits,
  );
  await ctx.orchestrator.whenSettled(task.id);
  return { ...ctx, taskId: task.id };
}

describe('Claude clarification flow', () => {
  it('resumes the same Claude session once, then produces a plan', async () => {
    const { orchestrator, claude, project, taskId } = await submitClarifying(1);
    const waiting = orchestrator.getTask(taskId);
    expect(waiting.state).toBe('awaiting_clarification');
    expect(waiting.clarificationRound).toBe(1);
    expect(waiting.plan).toBeNull();

    const accepted = orchestrator.answerClarification(taskId, 'Use the existing test framework.');
    expect(accepted.state).toBe('draft');
    await orchestrator.whenSettled(taskId);

    const planned = orchestrator.getTask(taskId);
    expect(planned.state).toBe('awaiting_approval');
    expect(planned.plan?.title).toBe('Build a tiny thing [fake-clarify:1]');
    expect(planned.plan?.steps).toHaveLength(3);
    const runs = orchestrator.listRuns(taskId).filter((run) => run.provider === 'claude');
    expect(runs).toHaveLength(2);
    expect(new Set(runs.map((run) => run.sessionId)).size).toBe(1);
    expect(claude.inputs).toHaveLength(2);
    expect(orchestrator.listMessages(project.id).map((message) => message.role)).toEqual([
      'user',
      'claude',
      'user',
      'claude',
    ]);
  });

  it('supports multiple clarification rounds', async () => {
    const { orchestrator, taskId } = await submitClarifying(2);
    orchestrator.answerClarification(taskId, 'First answer');
    await orchestrator.whenSettled(taskId);
    expect(orchestrator.getTask(taskId).state).toBe('awaiting_clarification');
    orchestrator.answerClarification(taskId, 'Second answer');
    await orchestrator.whenSettled(taskId);
    expect(orchestrator.getTask(taskId)).toMatchObject({
      state: 'awaiting_approval',
      clarificationRound: 2,
    });
  });

  it('fails clearly when Claude exceeds the clarification limit', async () => {
    const { orchestrator, taskId } = await submitClarifying(2, { maxClarificationRounds: 1 });
    orchestrator.answerClarification(taskId, 'Still ambiguous');
    await orchestrator.whenSettled(taskId);
    expect(orchestrator.getTask(taskId)).toMatchObject({
      state: 'failed',
      failure: { code: 'CLARIFICATION_ROUNDS_EXCEEDED' },
    });
    expect(orchestrator.listTimeline(taskId).map((event) => event.type)).toContain(
      'clarification_limit_exceeded',
    );
  });

  it('can cancel while waiting for clarification and rejects an answer in the wrong state', async () => {
    const { orchestrator, taskId } = await submitClarifying(1);
    const cancelled = await orchestrator.cancel(taskId);
    expect(cancelled.state).toBe('cancelled');
    expect(() => orchestrator.answerClarification(taskId, 'late')).toThrow(OrchestrationError);
    expect(orchestrator.listRuns(taskId)).toHaveLength(1);
  });

  it('deduplicates concurrent clarification answers before another call is created', async () => {
    const { orchestrator, taskId } = await submitClarifying(1);
    orchestrator.answerClarification(taskId, 'first');
    expect(() => orchestrator.answerClarification(taskId, 'duplicate')).toThrow(OrchestrationError);
    await orchestrator.whenSettled(taskId);
    expect(orchestrator.listRuns(taskId).filter((run) => run.provider === 'claude')).toHaveLength(
      2,
    );
  });
});

describe('central execution budget guard', () => {
  it('blocks a run-count overage before entering the provider', async () => {
    const { orchestrator, claude, taskId } = await submitClarifying(1, { maxClaudeRuns: 1 });
    expect(claude.inputs).toHaveLength(1);
    orchestrator.answerClarification(taskId, 'answer');
    await orchestrator.whenSettled(taskId);
    expect(claude.inputs).toHaveLength(1);
    expect(orchestrator.getTask(taskId).failure?.code).toBe('CLAUDE_RUN_LIMIT_EXCEEDED');
    expect(orchestrator.listTimeline(taskId).map((event) => event.type)).toContain(
      'budget_blocked',
    );
  });

  it('blocks at the next run boundary when known tokens reach the ceiling', async () => {
    const { orchestrator, claude, taskId } = await submitClarifying(1, {
      claudeTokenCeiling: 200,
    });
    orchestrator.answerClarification(taskId, 'answer');
    await orchestrator.whenSettled(taskId);
    expect(claude.inputs).toHaveLength(1);
    expect(orchestrator.getTask(taskId).failure?.code).toBe('CLAUDE_TOKEN_CEILING_REACHED');
  });

  it('blocks a Codex revision before the second provider entry', async () => {
    const { orchestrator, codex, project } = setup();
    const task = await orchestrator.submitRequest(project.id, 'Revise once [fake-changes:1]', {
      maxCodexRuns: 1,
    });
    await orchestrator.whenSettled(task.id);
    orchestrator.approve(task.id);
    await orchestrator.whenSettled(task.id);
    expect(codex.inputs).toHaveLength(1);
    expect(orchestrator.getTask(task.id)).toMatchObject({
      state: 'failed',
      failure: { code: 'CODEX_RUN_LIMIT_EXCEEDED' },
    });
    expect(
      orchestrator
        .listMessages(project.id)
        .some((message) => message.content.includes('CODEX_RUN_LIMIT_EXCEEDED')),
    ).toBe(true);
  });

  it('allows unlimited token ceilings', async () => {
    const { orchestrator, taskId } = await submitClarifying(1, {
      claudeTokenCeiling: null,
      codexTokenCeiling: null,
    });
    orchestrator.answerClarification(taskId, 'answer');
    await orchestrator.whenSettled(taskId);
    orchestrator.approve(taskId);
    await orchestrator.whenSettled(taskId);
    expect(orchestrator.getTask(taskId).state).toBe('completed');
    expect(orchestrator.budgetStatus(taskId).claude.tokenConfidence).toBe('unlimited');
  });
});
