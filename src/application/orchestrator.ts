import type { AgentEvent, AgentResult } from '../domain/agent-events.js';
import { OrchestrationError } from '../domain/errors.js';
import {
  asMessageId,
  asProjectId,
  asRunId,
  asTaskEventId,
  asTaskId,
  asUsageRecordId,
  type ProjectId,
  type RunId,
  type SessionId,
  type TaskId,
} from '../domain/ids.js';
import { truncateText, type Message, type MessageRole, type TaskEvent } from '../domain/message.js';
import type { Clock, IdGenerator } from '../domain/ports.js';
import type { Project } from '../domain/project.js';
import type { AgentProvider, Run, RunKind } from '../domain/run.js';
import { resolveReviewVerdict, transition } from '../domain/state-machine.js';
import {
  DEFAULT_MAX_REVIEW_ROUNDS,
  isTerminal,
  type Task,
  type TaskState,
} from '../domain/task.js';
import { summarizeUsage, type UsageRecord, type UsageSummary } from '../domain/usage.js';
import type { AgentAdapter } from '../infrastructure/agents/agent-adapter.js';
import { EventBus } from './events.js';
import type { Repositories } from './repositories.js';

export interface OrchestratorOptions {
  clock: Clock;
  ids: IdGenerator;
  claude: AgentAdapter;
  codex: AgentAdapter;
  repos: Repositories;
  bus?: EventBus;
  maxReviewRounds?: number;
}

interface RunOutcome {
  result: AgentResult | null;
  error: { code: string; message: string } | null;
  sessionId: SessionId | null;
}

/**
 * Drives tasks through the state machine. All state changes go through
 * `transition()`; the orchestrator never sets `task.state` directly.
 */
export class Orchestrator {
  readonly bus: EventBus;
  private readonly clock: Clock;
  private readonly ids: IdGenerator;
  private readonly claude: AgentAdapter;
  private readonly codex: AgentAdapter;
  private readonly repos: Repositories;
  private readonly maxReviewRounds: number;
  private readonly pipelines = new Map<TaskId, Promise<void>>();
  private readonly aborts = new Map<TaskId, AbortController>();

  constructor(opts: OrchestratorOptions) {
    this.clock = opts.clock;
    this.ids = opts.ids;
    this.claude = opts.claude;
    this.codex = opts.codex;
    this.repos = opts.repos;
    this.bus = opts.bus ?? new EventBus();
    this.maxReviewRounds = opts.maxReviewRounds ?? DEFAULT_MAX_REVIEW_ROUNDS;
  }

  // ---------- projects ----------

  /** `rootPath` must already be canonical/absolute; validation happens at the server boundary. */
  registerProject(name: string, rootPath: string): Project {
    const project: Project = {
      id: asProjectId(this.ids.next()),
      name,
      rootPath,
      createdAt: this.clock.now(),
    };
    this.repos.projects.insert(project);
    return project;
  }

  listProjects(): Project[] {
    return this.repos.projects.list();
  }

  // ---------- queries ----------

  getTask(taskId: TaskId): Task {
    const task = this.repos.tasks.findById(taskId);
    if (!task) throw new OrchestrationError('TASK_NOT_FOUND', `Task ${taskId} not found.`);
    return task;
  }

  listTasks(projectId: ProjectId): Task[] {
    return this.repos.tasks.listByProject(projectId);
  }

  listRuns(taskId: TaskId): Run[] {
    return this.repos.runs.listByTask(taskId);
  }

  listMessages(projectId: ProjectId): Message[] {
    return this.repos.messages.listByProject(projectId);
  }

  listTimeline(taskId: TaskId): TaskEvent[] {
    return this.repos.taskEvents.listByTask(taskId);
  }

  taskUsage(taskId: TaskId): UsageSummary {
    return summarizeUsage(this.repos.usage.listByTask(taskId));
  }

  projectUsage(projectId: ProjectId): UsageSummary {
    return summarizeUsage(this.repos.usage.listByProject(projectId));
  }

  // ---------- commands ----------

  /**
   * Create a task from a user request and ask the planner for a plan.
   * Resolves when the task is `awaiting_approval` (or `failed`).
   */
  async submitRequest(projectId: ProjectId, request: string): Promise<Task> {
    const project = this.repos.projects.findById(projectId);
    if (!project)
      throw new OrchestrationError('PROJECT_NOT_FOUND', `Project ${projectId} not found.`);

    const now = this.clock.now();
    let task: Task = {
      id: asTaskId(this.ids.next()),
      projectId,
      request,
      state: 'draft',
      plan: null,
      reviewRound: 0,
      maxReviewRounds: this.maxReviewRounds,
      reviews: [],
      codexSessionId: null,
      claudeSessionId: null,
      failure: null,
      createdAt: now,
      updatedAt: now,
    };
    this.repos.tasks.insert(task);
    this.bus.publish({ type: 'task_updated', task });
    this.addMessage(projectId, task.id, 'user', request);

    const outcome = await this.executeRun(task, 'claude', 'plan', request);
    task = this.getTask(task.id);
    if (outcome.sessionId) task = { ...task, claudeSessionId: outcome.sessionId };

    if (outcome.result?.kind === 'plan') {
      const { title, summary, steps } = outcome.result;
      task = this.save({ ...task, plan: { title, summary, steps } });
      task = this.move(task, 'awaiting_approval');
      this.addMessage(
        projectId,
        task.id,
        'claude',
        `**${title}**\n${summary}\n${steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}\n\nApprove to send to Codex.`,
      );
    } else {
      task = this.fail(
        task,
        outcome.error ?? { code: 'AGENT_RESULT_INVALID', message: 'Planner returned no plan.' },
      );
    }
    return task;
  }

  /** User approval. Transitions to `queued` and starts the implementation pipeline in the background. */
  approve(taskId: TaskId): Task {
    let task = this.getTask(taskId);
    task = this.move(task, 'queued', { userApproved: true });
    this.addMessage(task.projectId, task.id, 'system', 'Plan approved. Sending to Codex.');
    this.startPipeline(task.id);
    return task;
  }

  reject(taskId: TaskId, reason?: string): Task {
    let task = this.getTask(taskId);
    task = this.move(task, 'cancelled');
    this.addMessage(
      task.projectId,
      task.id,
      'system',
      `Plan rejected${reason ? `: ${reason}` : '.'}`,
    );
    return task;
  }

  /** Cancel a task in any non-terminal state; aborts a running agent if any. */
  async cancel(taskId: TaskId): Promise<Task> {
    const task = this.getTask(taskId);
    if (isTerminal(task.state)) {
      throw new OrchestrationError('INVALID_TRANSITION', `Task is already ${task.state}.`);
    }
    this.aborts.get(taskId)?.abort();
    await this.whenSettled(taskId);
    // Pipeline may have already moved it to a terminal state when it observed the abort.
    const latest = this.getTask(taskId);
    if (isTerminal(latest.state)) return latest;
    const cancelled = this.move(latest, 'cancelled');
    this.addMessage(cancelled.projectId, cancelled.id, 'system', 'Task cancelled by user.');
    return cancelled;
  }

  /** Resolves when no pipeline is running for the task. Used by tests and by cancel(). */
  async whenSettled(taskId: TaskId): Promise<void> {
    const p = this.pipelines.get(taskId);
    if (p) await p;
  }

  /**
   * Called on startup. Tasks interrupted mid-run are failed with INTERRUPTED;
   * queued tasks are restarted.
   */
  recoverInterrupted(): { restarted: TaskId[]; failed: TaskId[] } {
    const restarted: TaskId[] = [];
    const failed: TaskId[] = [];
    for (const task of this.repos.tasks.listAll()) {
      if (task.state === 'queued') {
        this.startPipeline(task.id);
        restarted.push(task.id);
      } else if (task.state === 'implementing' || task.state === 'reviewing') {
        for (const run of this.repos.runs.listByTask(task.id)) {
          if (run.status === 'running') {
            this.repos.runs.update({
              ...run,
              status: 'failed',
              finishedAt: this.clock.now(),
              error: { code: 'INTERRUPTED', message: 'Server restarted during run.' },
            });
          }
        }
        this.fail(task, {
          code: 'INTERRUPTED',
          message: 'Server restarted while the task was running.',
        });
        failed.push(task.id);
      }
    }
    return { restarted, failed };
  }

  // ---------- pipeline ----------

  private startPipeline(taskId: TaskId): void {
    if (this.pipelines.has(taskId)) return;
    const controller = new AbortController();
    this.aborts.set(taskId, controller);
    const p = this.runPipeline(taskId, controller.signal)
      .catch((err: unknown) => {
        const e =
          err instanceof OrchestrationError ? err : new OrchestrationError('INTERNAL', String(err));
        const task = this.repos.tasks.findById(taskId);
        if (task && !isTerminal(task.state)) this.fail(task, { code: e.code, message: e.message });
        this.bus.publish({ type: 'system_error', code: e.code, message: e.message, taskId });
      })
      .finally(() => {
        this.pipelines.delete(taskId);
        this.aborts.delete(taskId);
      });
    this.pipelines.set(taskId, p);
  }

  private async runPipeline(taskId: TaskId, signal: AbortSignal): Promise<void> {
    let task = this.getTask(taskId);

    // Loop: implement → review → (approved | changes_requested → implement again | failed)
    while (!isTerminal(task.state)) {
      if (signal.aborted) return;

      if (task.state === 'queued' || task.state === 'changes_requested') {
        const revising = task.state === 'changes_requested';
        task = this.move(task, 'implementing');
        const prompt = revising ? this.revisePrompt(task) : this.implementPrompt(task);
        const outcome = await this.executeRun(
          task,
          'codex',
          revising ? 'revise' : 'implement',
          prompt,
          signal,
        );
        task = this.getTask(task.id);
        if (outcome.sessionId) task = this.save({ ...task, codexSessionId: outcome.sessionId });

        if (outcome.result?.kind === 'implementation') {
          task = this.move(task, 'review_requested');
          this.addMessage(
            task.projectId,
            task.id,
            'codex',
            `${outcome.result.summary}\nChanged: ${outcome.result.changedFiles.join(', ') || '(none)'}\nTests: ${formatTests(outcome.result.testsPassed)}`,
          );
        } else {
          task = this.fail(
            task,
            outcome.error ?? {
              code: 'AGENT_RESULT_INVALID',
              message: 'Implementer returned no result.',
            },
          );
          break;
        }
      }

      if (task.state === 'review_requested') {
        task = this.move(task, 'reviewing');
        const outcome = await this.executeRun(
          task,
          'claude',
          'review',
          this.reviewPrompt(task),
          signal,
        );
        task = this.getTask(task.id);
        if (outcome.sessionId) task = this.save({ ...task, claudeSessionId: outcome.sessionId });

        if (outcome.result?.kind !== 'review') {
          task = this.fail(
            task,
            outcome.error ?? {
              code: 'AGENT_RESULT_INVALID',
              message: 'Reviewer returned no verdict.',
            },
          );
          break;
        }

        const { verdict, summary, changeRequests } = outcome.result;
        const round = task.reviewRound + 1;
        task = this.save({
          ...task,
          reviewRound: round,
          reviews: [
            ...task.reviews,
            { round, verdict, summary, changeRequests, recordedAt: this.clock.now() },
          ],
        });
        this.addMessage(
          task.projectId,
          task.id,
          'claude',
          `Review round ${round}: ${verdict === 'approve' ? 'APPROVED' : 'CHANGES REQUESTED'}\n${summary}${changeRequests.length ? `\n- ${changeRequests.join('\n- ')}` : ''}`,
        );

        const decision = resolveReviewVerdict(task, verdict);
        if (decision.next === 'failed') {
          task = this.fail(
            task,
            decision.failure ?? {
              code: 'REVIEW_ROUNDS_EXCEEDED',
              message: 'Review rounds exceeded.',
            },
          );
          break;
        }
        task = this.move(task, decision.next);
        if (task.state === 'approved') {
          task = this.move(task, 'completed');
          this.addMessage(task.projectId, task.id, 'system', 'Task completed.');
        }
      }
    }
  }

  // ---------- run execution ----------

  private async executeRun(
    task: Task,
    provider: AgentProvider,
    kind: RunKind,
    prompt: string,
    signal?: AbortSignal,
  ): Promise<RunOutcome> {
    const project = this.repos.projects.findById(task.projectId);
    if (!project)
      throw new OrchestrationError('PROJECT_NOT_FOUND', `Project ${task.projectId} not found.`);

    const adapter = provider === 'claude' ? this.claude : this.codex;
    const existingSession = provider === 'claude' ? task.claudeSessionId : task.codexSessionId;

    let run: Run = {
      id: asRunId(this.ids.next()),
      taskId: task.id,
      projectId: task.projectId,
      provider,
      kind,
      status: 'running',
      sessionId: existingSession,
      startedAt: this.clock.now(),
      finishedAt: null,
      error: null,
    };
    this.repos.runs.insert(run);
    this.bus.publish({ type: 'run_updated', run });
    this.appendTimeline(task.id, run.id, 'run_started', { provider, kind });

    const input = {
      runId: run.id,
      taskId: task.id,
      projectRoot: project.rootPath,
      kind,
      prompt,
      ...(signal ? { signal } : {}),
    };
    const stream = existingSession ? adapter.resume(existingSession, input) : adapter.start(input);

    const outcome: RunOutcome = { result: null, error: null, sessionId: existingSession };
    const messageBuffer: string[] = [];
    let messageBytes = 0;

    try {
      for await (const event of stream) {
        this.handleAgentEvent(task, run, event, outcome, (text) => {
          if (messageBytes < 8_000) {
            messageBuffer.push(text);
            messageBytes += text.length;
          }
        });
        if (event.type === 'session_started') run = { ...run, sessionId: event.sessionId };
        if (event.type === 'run_completed' || event.type === 'run_failed') break;
      }
    } catch (err) {
      outcome.error = {
        code: 'AGENT_RUN_FAILED',
        message: err instanceof Error ? err.message : String(err),
      };
    }

    if (!outcome.result && !outcome.error) {
      outcome.error = { code: 'AGENT_RUN_FAILED', message: 'Agent stream ended without a result.' };
    }
    if (messageBuffer.length) {
      this.appendTimeline(task.id, run.id, 'agent_message', {
        provider,
        text: truncateText(messageBuffer.join('')),
      });
    }

    run = {
      ...run,
      status: outcome.error
        ? outcome.error.code === 'CANCELLED'
          ? 'cancelled'
          : 'failed'
        : 'completed',
      finishedAt: this.clock.now(),
      error: outcome.error,
    };
    this.repos.runs.update(run);
    this.bus.publish({ type: 'run_updated', run });
    this.appendTimeline(task.id, run.id, 'run_finished', {
      provider,
      kind,
      status: run.status,
      error: run.error,
    });
    return outcome;
  }

  private handleAgentEvent(
    task: Task,
    run: Run,
    event: AgentEvent,
    outcome: RunOutcome,
    onText: (text: string) => void,
  ): void {
    switch (event.type) {
      case 'session_started':
        outcome.sessionId = event.sessionId;
        this.appendTimeline(task.id, run.id, event.type, { sessionId: event.sessionId });
        return;
      case 'message_delta':
        onText(event.text);
        return;
      case 'reasoning_delta':
        // Not persisted individually; kept out of storage to bound size.
        return;
      case 'command_started':
        this.appendTimeline(task.id, run.id, event.type, {
          commandId: event.commandId,
          command: event.command,
          cwd: event.cwd,
        });
        return;
      case 'command_completed':
        this.appendTimeline(task.id, run.id, event.type, {
          commandId: event.commandId,
          exitCode: event.exitCode,
          stdoutTail: truncateText(event.stdoutTail ?? '', 2_000),
          stderrTail: truncateText(event.stderrTail ?? '', 2_000),
        });
        return;
      case 'usage_reported': {
        const record: UsageRecord = {
          id: asUsageRecordId(this.ids.next()),
          provider: run.provider,
          projectId: task.projectId,
          taskId: task.id,
          runId: run.id,
          sessionId: outcome.sessionId,
          ...event.usage,
          recordedAt: this.clock.now(),
        };
        this.repos.usage.insert(record);
        this.appendTimeline(task.id, run.id, event.type, { ...event.usage });
        this.bus.publish({
          type: 'usage_updated',
          taskId: task.id,
          projectId: task.projectId,
          task: this.taskUsage(task.id),
          project: this.projectUsage(task.projectId),
        });
        return;
      }
      case 'run_completed':
        outcome.result = event.result;
        this.appendTimeline(task.id, run.id, event.type, { result: event.result });
        return;
      case 'run_failed':
        outcome.error = event.error;
        this.appendTimeline(task.id, run.id, event.type, { error: event.error });
        return;
    }
  }

  // ---------- prompts ----------

  private implementPrompt(task: Task): string {
    const plan = task.plan;
    return [
      `Task: ${task.request}`,
      plan ? `Plan: ${plan.title}\n${plan.steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}` : '',
    ]
      .filter(Boolean)
      .join('\n\n');
  }

  private revisePrompt(task: Task): string {
    const last = task.reviews[task.reviews.length - 1];
    return `Task: ${task.request}\n\nReview round ${last?.round ?? '?'} requested changes:\n- ${(last?.changeRequests ?? []).join('\n- ')}`;
  }

  private reviewPrompt(task: Task): string {
    return `Review the implementation for: ${task.request}\nRound ${task.reviewRound + 1} of ${task.maxReviewRounds}.`;
  }

  // ---------- helpers ----------

  private move(task: Task, to: TaskState, opts: { userApproved?: boolean } = {}): Task {
    const next = transition(task, to, this.clock.now(), opts);
    this.repos.tasks.update(next);
    this.appendTimeline(next.id, null, 'state_changed', { from: task.state, to });
    this.bus.publish({ type: 'task_updated', task: next });
    return next;
  }

  private fail(task: Task, failure: { code: string; message: string }): Task {
    const withFailure = this.save({ ...task, failure });
    const next = this.move(withFailure, 'failed');
    this.addMessage(
      next.projectId,
      next.id,
      'system',
      `Task failed (${failure.code}): ${failure.message}`,
    );
    this.bus.publish({
      type: 'system_error',
      code: failure.code,
      message: failure.message,
      taskId: next.id,
    });
    return next;
  }

  private save(task: Task): Task {
    const next = { ...task, updatedAt: this.clock.now() };
    this.repos.tasks.update(next);
    this.bus.publish({ type: 'task_updated', task: next });
    return next;
  }

  private addMessage(
    projectId: ProjectId,
    taskId: TaskId | null,
    role: MessageRole,
    content: string,
  ): void {
    const message: Message = {
      id: asMessageId(this.ids.next()),
      projectId,
      taskId,
      role,
      content: truncateText(content),
      createdAt: this.clock.now(),
    };
    this.repos.messages.insert(message);
    this.bus.publish({ type: 'message_added', message });
  }

  private appendTimeline(
    taskId: TaskId,
    runId: RunId | null,
    type: string,
    payload: Record<string, unknown>,
  ): void {
    const entry: TaskEvent = {
      id: asTaskEventId(this.ids.next()),
      taskId,
      runId,
      type,
      payload,
      createdAt: this.clock.now(),
    };
    this.repos.taskEvents.insert(entry);
    this.bus.publish({ type: 'timeline_appended', entry });
  }
}

function formatTests(passed: boolean | null): string {
  if (passed === null) return 'not reported';
  return passed ? 'passed' : 'FAILED';
}
