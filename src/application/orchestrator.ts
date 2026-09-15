import type { AgentEvent, AgentResult } from '../domain/agent-events.js';
import { OrchestrationError } from '../domain/errors.js';
import {
  budgetFailureFor,
  DEFAULT_MAX_CLARIFICATION_ROUNDS,
  DEFAULT_MAX_CLAUDE_RUNS,
  DEFAULT_MAX_CODEX_RUNS,
  executionBudgetStatus,
  type ExecutionBudgetStatus,
  type ExecutionLimitsInput,
} from '../domain/execution-limits.js';
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
import {
  noReviewContextCollector,
  unavailableReviewContext,
  type ReviewContext,
  type ReviewContextCollector,
} from './review-context.js';
import { buildReviewPrompt, type ImplementationReport } from './review-prompt.js';

export interface OrchestratorOptions {
  clock: Clock;
  ids: IdGenerator;
  claude: AgentAdapter;
  codex: AgentAdapter;
  repos: Repositories;
  bus?: EventBus;
  maxReviewRounds?: number;
  defaultExecutionLimits?: Partial<ExecutionLimitsInput>;
  /**
   * Collects the working-tree diff for review prompts. Optional: when omitted the reviewer is
   * told the diff is unavailable (`noReviewContextCollector`). The server always injects the
   * git-backed collector; tests inject doubles.
   */
  reviewContext?: ReviewContextCollector;
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
  private readonly defaultExecutionLimits: ExecutionLimitsInput;
  private readonly reviewContext: ReviewContextCollector;
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
    this.defaultExecutionLimits = validateExecutionLimits({
      maxClaudeRuns: DEFAULT_MAX_CLAUDE_RUNS,
      maxCodexRuns: DEFAULT_MAX_CODEX_RUNS,
      claudeTokenCeiling: null,
      codexTokenCeiling: null,
      maxClarificationRounds: DEFAULT_MAX_CLARIFICATION_ROUNDS,
      maxReviewRounds: this.maxReviewRounds,
      ...opts.defaultExecutionLimits,
    });
    this.reviewContext = opts.reviewContext ?? noReviewContextCollector;
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

  budgetStatus(taskId: TaskId): ExecutionBudgetStatus {
    const task = this.getTask(taskId);
    return executionBudgetStatus(
      task,
      this.repos.runs.listByTask(taskId),
      this.repos.usage.listByTask(taskId),
    );
  }

  // ---------- commands ----------

  /**
   * Create a task from a user request and start planning in the background.
   * Resolves immediately with the `draft` task; the planner moves it to
   * `awaiting_approval` (or `failed`) later. Use `whenSettled()` to wait.
   */
  async submitRequest(
    projectId: ProjectId,
    request: string,
    executionLimits?: Partial<ExecutionLimitsInput>,
  ): Promise<Task> {
    const project = this.repos.projects.findById(projectId);
    if (!project)
      throw new OrchestrationError('PROJECT_NOT_FOUND', `Project ${projectId} not found.`);

    const now = this.clock.now();
    const limits = validateExecutionLimits({
      ...this.defaultExecutionLimits,
      ...executionLimits,
    });
    const task: Task = {
      id: asTaskId(this.ids.next()),
      projectId,
      request,
      state: 'draft',
      plan: null,
      clarificationRound: 0,
      maxClarificationRounds: limits.maxClarificationRounds,
      reviewRound: 0,
      maxReviewRounds: limits.maxReviewRounds,
      maxClaudeRuns: limits.maxClaudeRuns,
      maxCodexRuns: limits.maxCodexRuns,
      claudeTokenCeiling: limits.claudeTokenCeiling,
      codexTokenCeiling: limits.codexTokenCeiling,
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
    this.appendTimeline(task.id, null, 'request_received', { length: request.length });

    // Registered synchronously so whenSettled() right after this call sees it.
    this.startPipeline(task.id, (signal) => this.runPlanning(task.id, signal));
    return task;
  }

  /** Persist one user answer, then resume the exact Claude planning session once. */
  answerClarification(taskId: TaskId, answer: string): Task {
    let task = this.getTask(taskId);
    if (task.state !== 'awaiting_clarification') {
      throw new OrchestrationError(
        'INVALID_TRANSITION',
        `Task cannot accept clarification while '${task.state}'.`,
      );
    }
    task = this.move(task, 'draft');
    this.addMessage(task.projectId, task.id, 'user', answer);
    this.appendTimeline(task.id, null, 'clarification_answered', {
      round: task.clarificationRound,
      length: answer.length,
    });
    const prompt = [
      task.request,
      '',
      `Completed clarification rounds: ${task.clarificationRound}.`,
      'Clarification response from the user:',
      answer,
      '',
      'Continue clarifying if essential information is still missing; otherwise return the final plan.',
      'For kind "plan", include title, summary, and steps. For kind "clarification", include question. Do not include fields for the other kind.',
    ].join('\n');
    this.startPipeline(task.id, (signal) => this.runPlanning(task.id, signal, prompt));
    return task;
  }

  /** User approval. Transitions to `queued` and starts the implementation pipeline in the background. */
  approve(taskId: TaskId): Task {
    let task = this.getTask(taskId);
    task = this.move(task, 'queued', { userApproved: true });
    this.addMessage(task.projectId, task.id, 'system', 'Plan approved. Sending to Codex.');
    this.startImplementation(task.id);
    return task;
  }

  /** User rejection. Allowed while planning/clarifying or awaiting approval. */
  reject(taskId: TaskId, reason?: string): Task {
    let task = this.getTask(taskId);
    // Move first so a late planner result sees a non-draft state and leaves it alone.
    task = this.move(task, 'cancelled');
    this.aborts.get(taskId)?.abort();
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
   * Called on startup. In-memory pipelines and abort controllers do not survive a restart, so:
   * - `draft` (planning was in flight or never started): failed with INTERRUPTED. Planning is
   *   deliberately NOT re-run automatically; that would spend tokens without the user asking.
   * - `implementing` / `reviewing`: failed with INTERRUPTED, running runs closed.
   * - `queued`: nothing had started, safe to restart the implementation pipeline.
   * - `awaiting_approval` and terminal states: untouched.
   */
  recoverInterrupted(): { restarted: TaskId[]; failed: TaskId[] } {
    const restarted: TaskId[] = [];
    const failed: TaskId[] = [];
    for (const task of this.repos.tasks.listAll()) {
      // A task with a live pipeline in this process was not interrupted.
      if (this.pipelines.has(task.id)) continue;
      if (task.state === 'queued') {
        this.startImplementation(task.id);
        restarted.push(task.id);
      } else if (
        task.state === 'draft' ||
        task.state === 'implementing' ||
        task.state === 'reviewing'
      ) {
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
          message:
            task.state === 'draft'
              ? 'Server restarted while the plan was being prepared. Submit the request again.'
              : 'Server restarted while the task was running.',
        });
        failed.push(task.id);
      }
    }
    return { restarted, failed };
  }

  // ---------- pipelines ----------

  /**
   * Register one background pipeline per task. Unexpected errors fail the task and emit
   * `system_error`; a body that returns early because of an abort is not an error.
   * Cleanup only removes the entry it created, so a pipeline registered later for the
   * same task is never deleted by an older one finishing.
   */
  private startPipeline(taskId: TaskId, body: (signal: AbortSignal) => Promise<void>): void {
    if (this.pipelines.has(taskId)) return;
    const controller = new AbortController();
    const promise: Promise<void> = body(controller.signal)
      .catch((err: unknown) => {
        const e =
          err instanceof OrchestrationError ? err : new OrchestrationError('INTERNAL', String(err));
        const task = this.repos.tasks.findById(taskId);
        if (task && !isTerminal(task.state)) this.fail(task, { code: e.code, message: e.message });
        this.bus.publish({ type: 'system_error', code: e.code, message: e.message, taskId });
      })
      .finally(() => {
        if (this.pipelines.get(taskId) === promise) {
          this.pipelines.delete(taskId);
          this.aborts.delete(taskId);
        }
      });
    this.pipelines.set(taskId, promise);
    this.aborts.set(taskId, controller);
  }

  private startImplementation(taskId: TaskId): void {
    this.startPipeline(taskId, (signal) => this.runImplementation(taskId, signal));
  }

  /** draft → (Claude plan run) → awaiting_approval | failed. Leaves the task alone if it left `draft` meanwhile. */
  private async runPlanning(taskId: TaskId, signal: AbortSignal, prompt?: string): Promise<void> {
    let task = this.getTask(taskId);
    if (task.state !== 'draft' || signal.aborted) return;

    const outcome = await this.executeRun(
      task,
      'claude',
      'plan',
      prompt ?? this.planningPrompt(task),
      signal,
    );

    // Cancelled or rejected while the planner was running: cancel()/reject() own the final state.
    task = this.getTask(taskId);
    if (signal.aborted || task.state !== 'draft') return;

    if (outcome.sessionId) task = this.save({ ...task, claudeSessionId: outcome.sessionId });

    if (outcome.result?.kind === 'clarification') {
      const round = task.clarificationRound + 1;
      if (round > task.maxClarificationRounds) {
        this.appendTimeline(task.id, null, 'clarification_limit_exceeded', {
          attemptedRound: round,
          maxClarificationRounds: task.maxClarificationRounds,
        });
        this.fail(task, {
          code: 'CLARIFICATION_ROUNDS_EXCEEDED',
          message: `Claude requested clarification beyond ${task.maxClarificationRounds} allowed rounds. Submit a new task with more detail or a higher limit.`,
        });
        return;
      }
      task = this.save({ ...task, clarificationRound: round });
      this.addMessage(task.projectId, task.id, 'claude', outcome.result.question);
      this.appendTimeline(task.id, null, 'clarification_requested', { round });
      this.move(task, 'awaiting_clarification');
      return;
    }

    if (outcome.result?.kind === 'plan') {
      const { title, summary, steps } = outcome.result;
      task = this.save({ ...task, plan: { title, summary, steps } });
      task = this.move(task, 'awaiting_approval');
      this.addMessage(
        task.projectId,
        task.id,
        'claude',
        `**${title}**\n${summary}\n${steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}\n\nApprove to send to Codex.`,
      );
      return;
    }
    this.fail(
      task,
      outcome.error ?? { code: 'AGENT_RESULT_INVALID', message: 'Planner returned no plan.' },
    );
  }

  private async runImplementation(taskId: TaskId, signal: AbortSignal): Promise<void> {
    let task = this.getTask(taskId);
    // Held in memory for the next review prompt only. Never persisted; refreshed every round.
    let implementation: ImplementationReport | null = null;
    let context: ReviewContext | null = null;

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
        if (signal.aborted) return; // cancelled mid-run: cancel() owns the final state

        if (outcome.result?.kind === 'implementation') {
          implementation = {
            summary: outcome.result.summary,
            changedFiles: [...outcome.result.changedFiles],
            testsPassed: outcome.result.testsPassed,
          };
          // Fresh snapshot of the working tree after every implement/revise run.
          context = await this.collectReviewContext(task, implementation.changedFiles, signal);
          if (signal.aborted) return; // cancelled during collection: cancel() owns the final state
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
        const prompt = buildReviewPrompt({
          task,
          implementation,
          context: context ?? unavailableReviewContext('No review context was collected.'),
          previousReviews: task.reviews,
        });
        // The prompt (and the diff inside it) exists only for this call.
        context = null;
        const outcome = await this.executeRun(task, 'claude', 'review', prompt, signal);
        task = this.getTask(task.id);
        if (outcome.sessionId) task = this.save({ ...task, claudeSessionId: outcome.sessionId });
        if (signal.aborted) return; // cancelled mid-review: cancel() owns the final state

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

    const budgetFailure = budgetFailureFor(
      provider,
      task,
      this.repos.runs.listByTask(task.id),
      this.repos.usage.listByTask(task.id),
    );
    if (budgetFailure) {
      this.appendTimeline(task.id, null, 'budget_blocked', {
        provider,
        code: budgetFailure.code,
      });
      return { result: null, error: budgetFailure, sessionId: null };
    }

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
    this.publishBudget(task.id);
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
        this.appendTimeline(task.id, run.id, event.type, { sessionPresent: true });
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
        this.publishBudget(task.id);
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

  private planningPrompt(task: Task): string {
    return [
      task.request,
      '',
      'Act as the project planner. If essential information is missing, return one concise clarification question. Otherwise return a concrete implementation plan.',
      'For kind "plan", include title, summary, and steps. For kind "clarification", include question. Do not include fields for the other kind.',
    ].join('\n');
  }

  private implementPrompt(task: Task): string {
    const plan = task.plan;
    return [
      `Task: ${task.request}`,
      plan ? `Plan: ${plan.title}\n${plan.steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}` : '',
      'Safety boundary: modify files only inside the registered project root. Do not write to OS temporary directories or any outside path.',
    ]
      .filter(Boolean)
      .join('\n\n');
  }

  private revisePrompt(task: Task): string {
    const last = task.reviews[task.reviews.length - 1];
    return [
      `Task: ${task.request}`,
      `Review round ${last?.round ?? '?'} requested changes:\n- ${(last?.changeRequests ?? []).join('\n- ')}`,
      'Safety boundary: modify files only inside the registered project root. Do not write to OS temporary directories or any outside path.',
    ].join('\n\n');
  }

  /**
   * Ask the collector for the current diff. Collector-level problems (not a repo, git failed)
   * come back as `unavailable` and the review proceeds. An unexpected throw is surfaced as a
   * system_error event (no paths or content) and also degrades to `unavailable`.
   */
  private async collectReviewContext(
    task: Task,
    changedFiles: readonly string[],
    signal: AbortSignal,
  ): Promise<ReviewContext> {
    const project = this.repos.projects.findById(task.projectId);
    if (!project) return unavailableReviewContext('Project not found.');
    try {
      return await this.reviewContext.collect({
        projectRoot: project.rootPath,
        changedFiles,
        signal,
      });
    } catch (err) {
      if (signal.aborted) return unavailableReviewContext('Cancelled.');
      const code = err instanceof OrchestrationError ? err.code : 'REVIEW_CONTEXT_FAILED';
      this.bus.publish({
        type: 'system_error',
        code,
        message: 'Review context collection failed; the review continues without a diff.',
        taskId: task.id,
      });
      return unavailableReviewContext('Review context collection failed.');
    }
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

  private publishBudget(taskId: TaskId): void {
    this.bus.publish({ type: 'budget_updated', taskId, budget: this.budgetStatus(taskId) });
  }
}

function validateExecutionLimits(limits: ExecutionLimitsInput): ExecutionLimitsInput {
  for (const [name, value] of [
    ['maxClaudeRuns', limits.maxClaudeRuns],
    ['maxCodexRuns', limits.maxCodexRuns],
    ['maxClarificationRounds', limits.maxClarificationRounds],
    ['maxReviewRounds', limits.maxReviewRounds],
  ] as const) {
    if (!Number.isInteger(value) || value <= 0) {
      throw new OrchestrationError('VALIDATION_FAILED', `${name} must be a positive integer.`);
    }
  }
  for (const [name, value] of [
    ['claudeTokenCeiling', limits.claudeTokenCeiling],
    ['codexTokenCeiling', limits.codexTokenCeiling],
  ] as const) {
    if (value !== null && (!Number.isSafeInteger(value) || value <= 0)) {
      throw new OrchestrationError(
        'VALIDATION_FAILED',
        `${name} must be a positive safe integer or null.`,
      );
    }
  }
  return { ...limits };
}

function formatTests(passed: boolean | null): string {
  if (passed === null) return 'not reported';
  return passed ? 'passed' : 'FAILED';
}
