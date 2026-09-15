import { spawn, type ChildProcess } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { sep } from 'node:path';

import { OrchestrationError } from '../../domain/errors.js';

/**
 * Safe child-process wrapper.
 * - argv array only, never a shell string (`shell: false`)
 * - cwd must be inside the canonical project root
 * - env is an explicit allowlist, never the full parent env
 * - stdout/stderr captured separately with a bounded tail
 * - timeout + AbortSignal, children tracked and killed on process exit
 */

export interface SpawnOptions {
  file: string;
  args: string[];
  cwd: string;
  projectRoot: string;
  /** Only these keys are passed to the child (plus BASE_ENV_KEYS from the parent). */
  env?: Record<string, string>;
  stdin?: string;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Per-stream cap. Beyond it only the tail is kept and `truncated` is set. */
  maxOutputBytes?: number;
  /** Logger for one summary line per run. Never receives prompt/output. Defaults to silent. */
  log?: (line: string) => void;
  /** Delay between SIGTERM and SIGKILL. Default 5000 ms; tests use a small value. */
  killGraceMs?: number;
}

export interface ProcessResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  /** How the process ended. */
  outcome: 'exited' | 'timeout' | 'aborted' | 'spawn_error';
  stdoutTail: string;
  stderrTail: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  durationMs: number;
  spawnError: string | null;
}

export interface RunningProcess {
  readonly pid: number | undefined;
  /** Line-delimited stdout. Iterate before awaiting `done` to stream. */
  stdoutLines(): AsyncIterable<string>;
  readonly done: Promise<ProcessResult>;
  kill(): void;
}

/** Parent env keys that are always forwarded (needed to locate executables and temp dirs). */
export const BASE_ENV_KEYS = [
  'PATH',
  'Path',
  'HOME',
  'USERPROFILE',
  'SYSTEMROOT',
  'SystemRoot',
  'TEMP',
  'TMP',
  'COMSPEC',
  'PATHEXT',
] as const;

const DEFAULT_MAX_OUTPUT = 2 * 1024 * 1024;
const DEFAULT_KILL_GRACE_MS = 5_000;

const children = new Set<ChildProcess>();
let exitHookInstalled = false;

function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  const killAll = () => {
    for (const c of children) {
      try {
        c.kill();
      } catch {
        // already gone
      }
    }
  };
  process.once('exit', killAll);
  process.once('SIGINT', () => {
    killAll();
    process.exit(130);
  });
  process.once('SIGTERM', () => {
    killAll();
    process.exit(143);
  });
}

/** Number of tracked children; exposed for tests. */
export function trackedChildCount(): number {
  return children.size;
}

/** Canonicalize `cwd` and verify it is `projectRoot` or inside it. */
export function assertInsideProjectRoot(
  cwd: string,
  projectRoot: string,
): { cwd: string; projectRoot: string } {
  let root: string;
  let dir: string;
  try {
    root = realpathSync.native(projectRoot);
  } catch {
    throw new OrchestrationError('INVALID_PROJECT_ROOT', 'Project root does not exist.', {
      projectRoot,
    });
  }
  try {
    dir = realpathSync.native(cwd);
  } catch {
    throw new OrchestrationError('INVALID_PROJECT_ROOT', 'Working directory does not exist.', {
      cwd,
    });
  }
  const rootWithSep = root.endsWith(sep) ? root : root + sep;
  if (dir !== root && !dir.startsWith(rootWithSep)) {
    throw new OrchestrationError(
      'INVALID_PROJECT_ROOT',
      'Working directory is outside the project root.',
      {
        cwd: dir,
        projectRoot: root,
      },
    );
  }
  return { cwd: dir, projectRoot: root };
}

function buildEnv(allow: Record<string, string> | undefined): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of BASE_ENV_KEYS) {
    const v = process.env[key];
    if (v !== undefined) env[key] = v;
  }
  if (allow) for (const [k, v] of Object.entries(allow)) env[k] = v;
  return env;
}

/** Keeps at most `max` bytes (tail) of a stream. */
class TailBuffer {
  private chunks: Buffer[] = [];
  private size = 0;
  truncated = false;

  constructor(private readonly max: number) {}

  push(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.size += chunk.length;
    while (this.size > this.max && this.chunks.length > 0) {
      const first = this.chunks[0];
      if (!first) break;
      if (this.size - first.length >= this.max) {
        this.chunks.shift();
        this.size -= first.length;
      } else {
        const drop = this.size - this.max;
        this.chunks[0] = first.subarray(drop);
        this.size -= drop;
      }
      this.truncated = true;
    }
  }

  toString(): string {
    return Buffer.concat(this.chunks).toString('utf8');
  }
}

/** Async queue that turns push-based chunks into pulled lines. */
class LineQueue {
  private lines: string[] = [];
  private partial = '';
  private closed = false;
  private waiter: (() => void) | null = null;

  push(chunk: Buffer): void {
    const text = this.partial + chunk.toString('utf8');
    const parts = text.split(/\r?\n/);
    this.partial = parts.pop() ?? '';
    for (const p of parts) this.lines.push(p);
    this.wake();
  }

  close(): void {
    if (this.partial.length) this.lines.push(this.partial);
    this.partial = '';
    this.closed = true;
    this.wake();
  }

  private wake(): void {
    const w = this.waiter;
    this.waiter = null;
    w?.();
  }

  async *iterate(): AsyncGenerator<string> {
    for (;;) {
      if (this.lines.length) {
        yield this.lines.shift() as string;
        continue;
      }
      if (this.closed) return;
      await new Promise<void>((r) => (this.waiter = r));
    }
  }
}

export function runProcess(opts: SpawnOptions): RunningProcess {
  const { cwd, projectRoot } = assertInsideProjectRoot(opts.cwd, opts.projectRoot);
  void projectRoot;
  installExitHook();

  const maxBytes = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;
  const stdoutTail = new TailBuffer(maxBytes);
  const stderrTail = new TailBuffer(maxBytes);
  const lines = new LineQueue();
  const log = opts.log ?? (() => undefined);
  const started = Date.now();

  let outcome: ProcessResult['outcome'] = 'exited';
  let spawnError: string | null = null;
  let killTimer: NodeJS.Timeout | null = null;

  const child = spawn(opts.file, opts.args, {
    cwd,
    env: buildEnv(opts.env),
    shell: false,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  children.add(child);

  const terminate = (reason: ProcessResult['outcome']) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    outcome = reason;
    try {
      child.kill('SIGTERM');
    } catch {
      // ignore
    }
    killTimer = setTimeout(() => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore
      }
      // Windows: kill() does not reach grandchildren; taskkill the tree. argv array, no shell.
      if (process.platform === 'win32' && child.pid !== undefined) {
        try {
          spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
            shell: false,
            windowsHide: true,
            stdio: 'ignore',
          }).unref();
        } catch {
          // ignore
        }
      }
    }, opts.killGraceMs ?? DEFAULT_KILL_GRACE_MS);
    killTimer.unref();
  };

  const timeout = setTimeout(() => terminate('timeout'), opts.timeoutMs);
  timeout.unref();

  const onAbort = () => terminate('aborted');
  if (opts.signal) {
    if (opts.signal.aborted) onAbort();
    else opts.signal.addEventListener('abort', onAbort, { once: true });
  }

  child.stdout?.on('data', (chunk: Buffer) => {
    stdoutTail.push(chunk);
    lines.push(chunk);
  });
  child.stderr?.on('data', (chunk: Buffer) => stderrTail.push(chunk));

  if (opts.stdin !== undefined && child.stdin) {
    child.stdin.on('error', () => undefined); // EPIPE if child exits early
    child.stdin.end(opts.stdin);
  } else {
    child.stdin?.end();
  }

  const done = new Promise<ProcessResult>((resolve) => {
    let settled = false;
    const finish = (exitCode: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      opts.signal?.removeEventListener('abort', onAbort);
      children.delete(child);
      lines.close();
      const durationMs = Date.now() - started;
      log(
        `[process] file=${opts.file} argc=${opts.args.length} cwd=${cwd} outcome=${outcome} exit=${String(exitCode)} ms=${durationMs}`,
      );
      resolve({
        exitCode,
        signal,
        outcome,
        stdoutTail: stdoutTail.toString(),
        stderrTail: stderrTail.toString(),
        stdoutTruncated: stdoutTail.truncated,
        stderrTruncated: stderrTail.truncated,
        durationMs,
        spawnError,
      });
    };
    child.once('error', (err) => {
      spawnError = err.message;
      outcome = 'spawn_error';
      finish(null, null);
    });
    child.once('close', (code, signal) => finish(code, signal));
  });

  return {
    pid: child.pid,
    stdoutLines: () => lines.iterate(),
    done,
    kill: () => terminate('aborted'),
  };
}
