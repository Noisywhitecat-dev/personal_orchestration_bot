import { existsSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import type { AgentEvent } from '../../domain/agent-events.js';
import { OrchestrationError } from '../../domain/errors.js';
import type { RunId, SessionId } from '../../domain/ids.js';
import type { Clock } from '../../domain/ports.js';
import { runProcess, type RunningProcess } from '../process/process-runner.js';
import type { AgentAdapter, AgentRunInput } from './agent-adapter.js';
import { CodexJsonlParser } from './codex-jsonl-parser.js';

/**
 * Real Codex CLI adapter. Verified against `codex-cli 0.154.0-alpha.6.2`:
 *
 *   start : codex exec --json --sandbox workspace-write -C <projectRoot> [--skip-git-repo-check] -
 *   resume: codex exec resume --json -c sandbox_mode="workspace-write" <sessionId> -
 *
 * `exec resume` has no `--sandbox` / `-C` flags on this version, so the sandbox is pinned via the
 * generic `-c` config override (both subcommands accept it) and cwd is set on the process instead.
 * This matters because the user-level config.toml may set `sandbox_mode = "danger-full-access"`.
 * The prompt is always written to stdin (trailing `-`).
 */

export const SANDBOX_MODE = 'workspace-write';
export type CodexReasoningEffort =
  'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';

export const REQUIRED_WINDOWS_CODEX_RUNTIME_FILES = [
  'codex.exe',
  'codex-code-mode-host.exe',
  'codex-command-runner.exe',
  'codex-windows-sandbox-setup.exe',
] as const;

/**
 * Fail fast for an explicitly selected Windows Codex binary whose sibling runtime is incomplete.
 * PATH-based `codex` and wrapper/stub executables are intentionally left to normal spawn lookup.
 */
export function assertCompleteLocalCodexRuntime(
  executable: string,
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform !== 'win32' || !isAbsolute(executable)) return;
  const executableName = basename(executable).toLowerCase();
  if (executableName !== 'codex.exe') return;

  const runtimeDir = dirname(executable);
  const missing = REQUIRED_WINDOWS_CODEX_RUNTIME_FILES.filter(
    (file) => !existsSync(join(runtimeDir, file)),
  );
  if (missing.length === 0) return;

  throw new OrchestrationError(
    'VALIDATION_FAILED',
    `Incomplete Codex runtime for executable "${executable}"; missing required component(s): ${missing.join(', ')}`,
  );
}

/** Keep provider-reported changes inside the project and expose portable relative paths. */
export function normalizeCodexChangedFiles(
  changedFiles: readonly string[],
  projectRoot: string,
): string[] {
  const root = resolve(projectRoot);
  const normalized: string[] = [];
  for (const file of changedFiles) {
    const rel = relative(root, resolve(root, file));
    if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) continue;
    const portable = rel.split(sep).join('/');
    if (!normalized.includes(portable)) normalized.push(portable);
  }
  return normalized;
}

/** Never allowed in argv, in any position. Tested in codex-cli-adapter.test.ts. */
export const FORBIDDEN_CODEX_ARGS: readonly string[] = [
  '--dangerously-bypass-approvals-and-sandbox',
  '--dangerously-bypass-hook-trust',
  '--yolo',
  '--full-auto',
];
/** Flag/value pairs that are never allowed (also checked in `--flag=value` form). */
export const FORBIDDEN_CODEX_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['--sandbox', 'danger-full-access'],
  ['-s', 'danger-full-access'],
  ['-a', 'never'],
  ['--ask-for-approval', 'never'],
];

export function assertNoForbiddenArgs(args: readonly string[]): void {
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i] ?? '';
    if (FORBIDDEN_CODEX_ARGS.includes(a)) {
      throw new OrchestrationError('VALIDATION_FAILED', `Forbidden Codex option: ${a}`);
    }
    for (const [flag, value] of FORBIDDEN_CODEX_PAIRS) {
      if (a === `${flag}=${value}` || (a === flag && args[i + 1] === value)) {
        throw new OrchestrationError(
          'VALIDATION_FAILED',
          `Forbidden Codex option: ${flag} ${value}`,
        );
      }
    }
    if (/^-c$/.test(a) && /^sandbox_mode\s*=\s*"?danger-full-access"?$/.test(args[i + 1] ?? '')) {
      throw new OrchestrationError(
        'VALIDATION_FAILED',
        'Forbidden Codex config override: sandbox_mode=danger-full-access',
      );
    }
  }
}

export interface StartArgsOptions {
  projectRoot: string;
  skipGitRepoCheck?: boolean;
  model?: string;
  reasoningEffort?: CodexReasoningEffort;
}

function addModelArgs(
  args: string[],
  opts: { model?: string; reasoningEffort?: CodexReasoningEffort },
): void {
  if (opts.model !== undefined) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(opts.model)) {
      throw new OrchestrationError('VALIDATION_FAILED', 'model has an invalid format.');
    }
    args.push('--model', opts.model);
  }
  if (opts.reasoningEffort !== undefined) {
    args.push('-c', `model_reasoning_effort="${opts.reasoningEffort}"`);
  }
}

/** Pure. argv for a new session (after the executable). */
export function buildStartArgs(opts: StartArgsOptions): string[] {
  const args = ['exec', '--json', '--sandbox', SANDBOX_MODE, '-C', opts.projectRoot];
  addModelArgs(args, opts);
  if (opts.skipGitRepoCheck) args.push('--skip-git-repo-check');
  args.push('-');
  assertNoForbiddenArgs(args);
  return args;
}

export interface ResumeArgsOptions {
  sessionId: string;
  skipGitRepoCheck?: boolean;
  model?: string;
  reasoningEffort?: CodexReasoningEffort;
}

/** Pure. argv for resuming (after the executable). No --sandbox/-C on this CLI version. */
export function buildResumeArgs(opts: ResumeArgsOptions): string[] {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(opts.sessionId)) {
    throw new OrchestrationError('VALIDATION_FAILED', 'Session id contains unexpected characters.');
  }
  const args = ['exec', 'resume', '--json', '-c', `sandbox_mode="${SANDBOX_MODE}"`];
  addModelArgs(args, opts);
  if (opts.skipGitRepoCheck) args.push('--skip-git-repo-check');
  args.push(opts.sessionId, '-');
  assertNoForbiddenArgs(args);
  return args;
}

export interface CodexCliAdapterOptions {
  /** Executable name or absolute path. Default `codex`. Tests pass `process.execPath` + a stub script. */
  executable?: string;
  /** Inserted before the codex argv (e.g. a stub script path when executable is node). */
  extraArgs?: string[];
  clock: Clock;
  timeoutMs?: number;
  skipGitRepoCheck?: boolean;
  /** Extra env passed to Codex on top of the runner's base allowlist. */
  env?: Record<string, string>;
  log?: (line: string) => void;
  killGraceMs?: number;
  /** When Codex reports no file changes, run `git status --porcelain` to fill changedFiles. Default true. */
  gitStatusFallback?: boolean;
  model?: string;
  reasoningEffort?: CodexReasoningEffort;
}

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;

export class CodexCliAdapter implements AgentAdapter {
  readonly provider = 'codex' as const;
  private readonly executable: string;
  private readonly extraArgs: string[];
  private readonly clock: Clock;
  private readonly timeoutMs: number;
  private readonly skipGitRepoCheck: boolean;
  private readonly env: Record<string, string> | undefined;
  private readonly log: ((line: string) => void) | undefined;
  private readonly killGraceMs: number | undefined;
  private readonly gitStatusFallback: boolean;
  private readonly model: string | undefined;
  private readonly reasoningEffort: CodexReasoningEffort | undefined;
  private readonly controllers = new Map<RunId, AbortController>();

  constructor(opts: CodexCliAdapterOptions) {
    this.executable = opts.executable ?? 'codex';
    assertCompleteLocalCodexRuntime(this.executable);
    this.extraArgs = opts.extraArgs ?? [];
    this.clock = opts.clock;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.skipGitRepoCheck = opts.skipGitRepoCheck ?? false;
    this.env = opts.env;
    this.log = opts.log;
    this.killGraceMs = opts.killGraceMs;
    this.gitStatusFallback = opts.gitStatusFallback ?? true;
    this.model = opts.model;
    this.reasoningEffort = opts.reasoningEffort;
  }

  start(input: AgentRunInput): AsyncIterable<AgentEvent> {
    const args = buildStartArgs({
      projectRoot: input.projectRoot,
      skipGitRepoCheck: this.skipGitRepoCheck,
      ...(this.model !== undefined ? { model: this.model } : {}),
      ...(this.reasoningEffort !== undefined ? { reasoningEffort: this.reasoningEffort } : {}),
    });
    return this.run(args, input, null);
  }

  resume(sessionId: SessionId, input: AgentRunInput): AsyncIterable<AgentEvent> {
    const args = buildResumeArgs({
      sessionId,
      skipGitRepoCheck: this.skipGitRepoCheck,
      ...(this.model !== undefined ? { model: this.model } : {}),
      ...(this.reasoningEffort !== undefined ? { reasoningEffort: this.reasoningEffort } : {}),
    });
    return this.run(args, input, sessionId);
  }

  async cancel(runId: RunId): Promise<void> {
    this.controllers.get(runId)?.abort();
  }

  private async *run(
    codexArgs: string[],
    input: AgentRunInput,
    resumeSessionId: SessionId | null,
  ): AsyncGenerator<AgentEvent> {
    const controller = new AbortController();
    this.controllers.set(input.runId, controller);
    const signals = input.signal ? [controller.signal, input.signal] : [controller.signal];
    const signal = AbortSignal.any(signals);
    const now = () => this.clock.now();
    const parser = new CodexJsonlParser(input.runId, now);

    let proc: RunningProcess;
    try {
      proc = runProcess({
        file: this.executable,
        args: [...this.extraArgs, ...codexArgs],
        cwd: input.projectRoot,
        projectRoot: input.projectRoot,
        stdin: input.prompt,
        timeoutMs: this.timeoutMs,
        signal,
        ...(this.env ? { env: this.env } : {}),
        ...(this.log ? { log: this.log } : {}),
        ...(this.killGraceMs !== undefined ? { killGraceMs: this.killGraceMs } : {}),
      });
    } catch (err) {
      this.controllers.delete(input.runId);
      const e =
        err instanceof OrchestrationError
          ? err
          : new OrchestrationError('AGENT_RUN_FAILED', String(err));
      yield {
        runId: input.runId,
        timestamp: now(),
        type: 'usage_reported',
        usage: {
          inputTokens: null,
          cachedInputTokens: null,
          outputTokens: null,
          reasoningTokens: null,
          totalTokens: null,
          source: 'unavailable',
        },
      };
      yield {
        runId: input.runId,
        timestamp: now(),
        type: 'run_failed',
        error: { code: e.code, message: e.message },
      };
      return;
    }

    try {
      // Resume: the orchestrator expects the session id to be (re)announced. If Codex later prints
      // the same id it is deduplicated by the parser; a different id is passed through.
      if (resumeSessionId) {
        parser.state.sessionId = resumeSessionId;
        yield {
          runId: input.runId,
          timestamp: now(),
          type: 'session_started',
          sessionId: resumeSessionId,
        };
      }

      for await (const line of proc.stdoutLines()) {
        for (const event of parser.parseLine(line)) {
          if (
            event.type === 'session_started' &&
            resumeSessionId &&
            event.sessionId === resumeSessionId
          )
            continue;
          if (event.type === 'run_completed') {
            yield* this.withChangedFiles(event, input);
          } else {
            yield event;
          }
        }
      }

      const result = await proc.done;
      for (const event of parser.finish(result)) {
        if (event.type === 'run_completed') yield* this.withChangedFiles(event, input);
        else yield event;
      }
    } finally {
      this.controllers.delete(input.runId);
    }
  }

  private async *withChangedFiles(
    event: Extract<AgentEvent, { type: 'run_completed' }>,
    input: AgentRunInput,
  ): AsyncGenerator<AgentEvent> {
    if (event.result.kind !== 'implementation') {
      yield event;
      return;
    }
    const normalized = normalizeCodexChangedFiles(event.result.changedFiles, input.projectRoot);
    if (normalized.length > 0 || !this.gitStatusFallback) {
      yield { ...event, result: { ...event.result, changedFiles: normalized } };
      return;
    }
    const files = await this.gitStatusFiles(input.projectRoot);
    yield { ...event, result: { ...event.result, changedFiles: files } };
  }

  private async gitStatusFiles(projectRoot: string): Promise<string[]> {
    try {
      const proc = runProcess({
        file: 'git',
        args: ['status', '--porcelain', '--untracked-files=all'],
        cwd: projectRoot,
        projectRoot,
        timeoutMs: 30_000,
        ...(this.log ? { log: this.log } : {}),
      });
      const result = await proc.done;
      if (result.exitCode !== 0) return [];
      return result.stdoutTail
        .split(/\r?\n/)
        .filter((l) => l.length > 3)
        .map((l) => l.slice(3).trim())
        .map((p) => (p.includes(' -> ') ? (p.split(' -> ')[1] ?? p) : p))
        .filter((p) => p.length > 0);
    } catch {
      return [];
    }
  }
}
