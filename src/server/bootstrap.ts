import type { QuotaWindow } from '../shared/account-usage.js';
import { installedRoleInstruction } from '../infrastructure/harness/project-harness.js';
import { preflight } from '../infrastructure/preflight.js';
import type { ModelCatalog } from '../shared/model-catalog.js';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Orchestrator } from '../application/orchestrator.js';
import {
  DEFAULT_MAX_CLARIFICATION_ROUNDS,
  DEFAULT_MAX_CLAUDE_RUNS,
  DEFAULT_MAX_CODEX_RUNS,
  type ExecutionLimitsInput,
} from '../domain/execution-limits.js';
import { systemClock } from '../domain/ports.js';
import type { AgentAdapter } from '../infrastructure/agents/agent-adapter.js';
import {
  CLAUDE_PERMISSION_MODE,
  ClaudeCliAdapter,
  type ClaudeEffort,
} from '../infrastructure/agents/claude-cli-adapter.js';
import {
  CodexCliAdapter,
  type CodexReasoningEffort,
} from '../infrastructure/agents/codex-cli-adapter.js';
import { FakeClaudeAdapter } from '../infrastructure/agents/fake-claude-adapter.js';
import { FakeCodexAdapter } from '../infrastructure/agents/fake-codex-adapter.js';
import { GitReviewContextCollector } from '../infrastructure/git/git-review-context-collector.js';
import { openDatabase } from '../infrastructure/persistence/database.js';
import { createSqliteRepositories } from '../infrastructure/persistence/sqlite-repositories.js';
import type { ExecutableStatus, RuntimeStatusResponse } from '../shared/contracts.js';
import { createApp } from './app.js';

export interface ApplicationServerOptions {
  onClaudeQuota?: ((windows: QuotaWindow[]) => void) | undefined;
  modelCatalog?: ModelCatalog;
  /** Defaults to loopback only. Use an explicit value to opt into another interface. */
  host?: string;
  /** Zero asks the OS for a free port. */
  port?: number;
  databasePath?: string;
  staticDir?: string;
  env?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
}

export interface RunningApplicationServer {
  url: string;
  port: number;
  close: () => Promise<void>;
}

function positiveIntEnv(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number | undefined,
): number | undefined {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Invalid ${name}: "${raw}" (positive integer expected)`);
  }
  return value;
}

function nullablePositiveIntEnv(env: NodeJS.ProcessEnv, name: string): number | null {
  return positiveIntEnv(env, name, undefined) ?? null;
}

function optionalEnumEnv<T extends string>(
  env: NodeJS.ProcessEnv,
  name: string,
  allowed: readonly T[],
): T | undefined {
  const raw = env[name];
  if (raw === undefined || raw === '') return undefined;
  if (!allowed.includes(raw as T)) {
    throw new Error(`Invalid ${name}: "${raw}" (expected ${allowed.join(', ')})`);
  }
  return raw as T;
}

function executableStatus(mode: 'fake' | 'cli', executable: string): ExecutableStatus {
  if (mode === 'fake') return 'not_required';
  if (!isAbsolute(executable)) return 'configured';
  return existsSync(executable) ? 'ready' : 'not_ready';
}

function selectClaudeAdapter(
  env: NodeJS.ProcessEnv,
  log: (line: string) => void,
  ids: { next: () => string },
  onQuota?: (windows: QuotaWindow[]) => void,
): {
  adapter: AgentAdapter;
  label: string;
  mode: 'fake' | 'cli';
  timeoutMs: number;
  executable: ExecutableStatus;
  model: string | null;
  effort: ClaudeEffort | null;
} {
  const mode = env['CLAUDE_ADAPTER'] ?? 'fake';
  if (mode === 'fake') {
    return {
      adapter: new FakeClaudeAdapter(systemClock, ids, { delayMs: 500 }),
      label: 'fake',
      mode,
      timeoutMs: 600_000,
      executable: 'not_required',
      model: null,
      effort: null,
    };
  }
  if (mode === 'cli') {
    const executable = env['CLAUDE_EXECUTABLE'] ?? 'claude';
    const timeoutMs = positiveIntEnv(env, 'CLAUDE_TIMEOUT_MS', 10 * 60 * 1000) as number;
    const maxTurns = positiveIntEnv(env, 'CLAUDE_MAX_TURNS', undefined);
    const model = env['CLAUDE_MODEL'] || undefined;
    const effort = optionalEnumEnv<ClaudeEffort>(env, 'CLAUDE_EFFORT', [
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ]);
    const adapter = new ClaudeCliAdapter({
      onQuota,
      executable,
      clock: systemClock,
      timeoutMs,
      ...(maxTurns !== undefined ? { maxTurns } : {}),
      ...(model !== undefined ? { model } : {}),
      ...(effort !== undefined ? { effort } : {}),
      log,
    });
    const turns = maxTurns !== undefined ? `, max-turns=${maxTurns}` : '';
    const executableLabel = isAbsolute(executable) ? basename(executable) : 'PATH lookup';
    return {
      adapter,
      label: `cli (${executableLabel}, permission-mode=${CLAUDE_PERMISSION_MODE} read-only, timeout=${timeoutMs}ms${turns})`,
      mode,
      timeoutMs,
      executable: executableStatus(mode, executable),
      model: model ?? null,
      effort: effort ?? null,
    };
  }
  throw new Error(`Invalid CLAUDE_ADAPTER="${mode}". Expected "fake" or "cli".`);
}

function selectCodexAdapter(
  env: NodeJS.ProcessEnv,
  log: (line: string) => void,
  ids: { next: () => string },
): {
  adapter: AgentAdapter;
  label: string;
  mode: 'fake' | 'cli';
  timeoutMs: number;
  executable: ExecutableStatus;
  model: string | null;
  effort: CodexReasoningEffort | null;
} {
  const mode = env['CODEX_ADAPTER'] ?? 'fake';
  if (mode === 'fake') {
    return {
      adapter: new FakeCodexAdapter(systemClock, ids, { delayMs: 500 }),
      label: 'fake',
      mode,
      timeoutMs: 900_000,
      executable: 'not_required',
      model: null,
      effort: null,
    };
  }
  if (mode === 'cli') {
    const executable = env['CODEX_EXECUTABLE'] ?? 'codex';
    const timeoutMs = Number(env['CODEX_TIMEOUT_MS'] ?? 15 * 60 * 1000);
    const skipGitRepoCheck = env['CODEX_SKIP_GIT_REPO_CHECK'] === '1';
    const model = env['CODEX_MODEL'] || undefined;
    const effort = optionalEnumEnv<CodexReasoningEffort>(env, 'CODEX_REASONING_EFFORT', [
      'minimal',
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
      'ultra',
    ]);
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new Error(`Invalid CODEX_TIMEOUT_MS: ${env['CODEX_TIMEOUT_MS']}`);
    }
    const adapter = new CodexCliAdapter({
      executable,
      clock: systemClock,
      timeoutMs,
      skipGitRepoCheck,
      ...(model !== undefined ? { model } : {}),
      ...(effort !== undefined ? { reasoningEffort: effort } : {}),
      log,
    });
    const executableLabel = isAbsolute(executable) ? basename(executable) : 'PATH lookup';
    return {
      adapter,
      label: `cli (${executableLabel}, sandbox=workspace-write, timeout=${timeoutMs}ms)`,
      mode,
      timeoutMs,
      executable: executableStatus(mode, executable),
      model: model ?? null,
      effort: effort ?? null,
    };
  }
  throw new Error(`Invalid CODEX_ADAPTER="${mode}". Expected "fake" or "cli".`);
}

function defaultStaticDir(): string | undefined {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [resolve(here, '../web'), resolve(here, '../../dist/web')];
  return candidates.find((directory) => existsSync(resolve(directory, 'index.html')));
}

/** Build and start the complete local application server. Used by both CLI and desktop shells. */
export async function startApplicationServer(
  options: ApplicationServerOptions = {},
): Promise<RunningApplicationServer> {
  const env = options.env ?? process.env;
  const log = options.log ?? console.log;
  const host = options.host ?? env['HOST'] ?? '127.0.0.1';
  const requestedPort = options.port ?? Number(env['PORT'] ?? 3080);
  if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65_535) {
    throw new Error(`Invalid PORT: ${String(requestedPort)}`);
  }
  const databasePath = resolve(
    options.databasePath ?? env['DATABASE_PATH'] ?? './data/orchestration.db',
  );
  const ids = { next: () => randomUUID() };
  const defaultExecutionLimits: ExecutionLimitsInput = {
    maxClaudeRuns: positiveIntEnv(env, 'MAX_CLAUDE_RUNS', DEFAULT_MAX_CLAUDE_RUNS) as number,
    maxCodexRuns: positiveIntEnv(env, 'MAX_CODEX_RUNS', DEFAULT_MAX_CODEX_RUNS) as number,
    claudeTokenCeiling: nullablePositiveIntEnv(env, 'CLAUDE_TOKEN_CEILING'),
    codexTokenCeiling: nullablePositiveIntEnv(env, 'CODEX_TOKEN_CEILING'),
    maxClarificationRounds: positiveIntEnv(
      env,
      'MAX_CLARIFICATION_ROUNDS',
      DEFAULT_MAX_CLARIFICATION_ROUNDS,
    ) as number,
    maxReviewRounds: positiveIntEnv(env, 'MAX_REVIEW_ROUNDS', 2) as number,
  };

  const claude = selectClaudeAdapter(env, log, ids, options.onClaudeQuota);
  const codex = selectCodexAdapter(env, log, ids);
  const reviewDiffMaxBytes = positiveIntEnv(env, 'REVIEW_DIFF_MAX_BYTES', 64 * 1024) as number;
  const reviewContext = new GitReviewContextCollector({ maxBytes: reviewDiffMaxBytes, log });
  const db = openDatabase(databasePath);
  const orchestrator = new Orchestrator({
    clock: systemClock,
    ids,
    claude: claude.adapter,
    codex: codex.adapter,
    repos: createSqliteRepositories(db),
    defaultExecutionLimits,
    reviewContext,
    roleSkill: installedRoleInstruction,
  });
  const recovery = orchestrator.recoverInterrupted();
  if (recovery.failed.length || recovery.restarted.length) {
    log(
      `[startup] recovered tasks: failed=${recovery.failed.length} restarted=${recovery.restarted.length}`,
    );
  }

  const staticDir = options.staticDir ?? defaultStaticDir();
  const runtimeStatus: RuntimeStatusResponse = {
    claude: {
      adapter: claude.mode,
      executable: claude.executable,
      timeoutMs: claude.timeoutMs,
      model: claude.model,
      effort: claude.effort,
    },
    codex: {
      adapter: codex.mode,
      executable: codex.executable,
      timeoutMs: codex.timeoutMs,
      model: codex.model,
      effort: codex.effort,
    },
    reviewDiffMaxBytes,
    database: basename(databasePath),
    defaultExecutionLimits,
  };
  const server = createApp({
    orchestrator,
    runtimeStatus,
    preflight: (root) =>
      preflight(
        root,
        runtimeStatus,
        { claude: env['CLAUDE_EXECUTABLE'] ?? 'claude', codex: env['CODEX_EXECUTABLE'] ?? 'codex' },
        undefined,
        options.modelCatalog,
      ),
    ...(staticDir ? { staticDir } : {}),
  });

  await new Promise<void>((resolveListen, rejectListen) => {
    const onError = (error: Error) => {
      server.off('listening', onListening);
      rejectListen(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolveListen();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(requestedPort, host);
  }).catch((error: unknown) => {
    db.close();
    throw error;
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    db.close();
    throw new Error('Application server did not expose a TCP address.');
  }
  const url = `http://${host}:${address.port}`;
  log(`[server] listening on ${url} (db: ${databasePath})`);
  log(`[server] adapters: claude=${claude.label} codex=${codex.label}`);
  log(`[server] review diff: git, max ${reviewDiffMaxBytes} bytes, memory-only`);
  if (!staticDir) log('[server] UI not built; use `npm run dev:web` for the Vite dev server.');

  let closed = false;
  return {
    url,
    port: address.port,
    close: async () => {
      if (closed) return;
      closed = true;
      const closedServer = new Promise<void>((resolveClose, rejectClose) => {
        server.close((error) => (error ? rejectClose(error) : resolveClose()));
        server.closeAllConnections();
      });
      await orchestrator.shutdown();
      await closedServer;
      db.close();
    },
  };
}
