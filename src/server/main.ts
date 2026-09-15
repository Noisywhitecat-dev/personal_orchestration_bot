import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Orchestrator } from '../application/orchestrator.js';
import { systemClock } from '../domain/ports.js';
import type { AgentAdapter } from '../infrastructure/agents/agent-adapter.js';
import { CodexCliAdapter } from '../infrastructure/agents/codex-cli-adapter.js';
import { FakeClaudeAdapter } from '../infrastructure/agents/fake-claude-adapter.js';
import { FakeCodexAdapter } from '../infrastructure/agents/fake-codex-adapter.js';
import { openDatabase } from '../infrastructure/persistence/database.js';
import { createSqliteRepositories } from '../infrastructure/persistence/sqlite-repositories.js';
import { createApp } from './app.js';

// Entry point. Wires SQLite + adapters. Claude is always the fake adapter for now;
// Codex is selected with CODEX_ADAPTER=fake|cli (default fake).

const port = Number(process.env['PORT'] ?? 3080);
const dbPath = resolve(process.env['DATABASE_PATH'] ?? './data/orchestration.db');
const maxReviewRounds = Number(process.env['MAX_REVIEW_ROUNDS'] ?? 2);

const ids = { next: () => randomUUID() };

function selectCodexAdapter(): { adapter: AgentAdapter; label: string } {
  const mode = process.env['CODEX_ADAPTER'] ?? 'fake';
  if (mode === 'fake') return { adapter: new FakeCodexAdapter(systemClock, ids), label: 'fake' };
  if (mode === 'cli') {
    const executable = process.env['CODEX_EXECUTABLE'] ?? 'codex';
    const timeoutMs = Number(process.env['CODEX_TIMEOUT_MS'] ?? 15 * 60 * 1000);
    const skipGitRepoCheck = process.env['CODEX_SKIP_GIT_REPO_CHECK'] === '1';
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new Error(`Invalid CODEX_TIMEOUT_MS: ${process.env['CODEX_TIMEOUT_MS']}`);
    }
    const adapter = new CodexCliAdapter({
      executable,
      clock: systemClock,
      timeoutMs,
      skipGitRepoCheck,
      log: (line) => console.log(line),
    });
    return {
      adapter,
      label: `cli (${executable}, sandbox=workspace-write, timeout=${timeoutMs}ms)`,
    };
  }
  throw new Error(`Invalid CODEX_ADAPTER="${mode}". Expected "fake" or "cli".`);
}

const codex = selectCodexAdapter();
const db = openDatabase(dbPath);
const orchestrator = new Orchestrator({
  clock: systemClock,
  ids,
  claude: new FakeClaudeAdapter(systemClock, ids),
  codex: codex.adapter,
  repos: createSqliteRepositories(db),
  maxReviewRounds,
});

const recovery = orchestrator.recoverInterrupted();
if (recovery.failed.length || recovery.restarted.length) {
  console.log(
    `[startup] recovered tasks: failed=${recovery.failed.length} restarted=${recovery.restarted.length}`,
  );
}

const here = dirname(fileURLToPath(import.meta.url));
const candidates = [resolve(here, '../web'), resolve(here, '../../dist/web')];
const staticDir = candidates.find((d) => existsSync(resolve(d, 'index.html')));

const server = createApp({ orchestrator, ...(staticDir ? { staticDir } : {}) });
server.listen(port, () => {
  console.log(`[server] listening on http://localhost:${port} (db: ${dbPath})`);
  console.log(`[server] adapters: claude=fake codex=${codex.label}`);
  if (!staticDir)
    console.log('[server] UI not built; use `npm run dev:web` for the Vite dev server.');
});

const shutdown = () => {
  server.close(() => {
    db.close();
    process.exit(0);
  });
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
