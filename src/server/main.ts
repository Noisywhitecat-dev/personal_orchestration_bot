import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Orchestrator } from '../application/orchestrator.js';
import { systemClock } from '../domain/ports.js';
import { FakeClaudeAdapter } from '../infrastructure/agents/fake-claude-adapter.js';
import { FakeCodexAdapter } from '../infrastructure/agents/fake-codex-adapter.js';
import { openDatabase } from '../infrastructure/persistence/database.js';
import { createSqliteRepositories } from '../infrastructure/persistence/sqlite-repositories.js';
import { createApp } from './app.js';

// Entry point. Wires SQLite + fake adapters. Real adapters are a later task (docs/CODEX_NEXT_TASK.md).

const port = Number(process.env['PORT'] ?? 3080);
const dbPath = resolve(process.env['DATABASE_PATH'] ?? './data/orchestration.db');
const maxReviewRounds = Number(process.env['MAX_REVIEW_ROUNDS'] ?? 2);

const ids = { next: () => randomUUID() };
const db = openDatabase(dbPath);
const orchestrator = new Orchestrator({
  clock: systemClock,
  ids,
  claude: new FakeClaudeAdapter(systemClock, ids),
  codex: new FakeCodexAdapter(systemClock, ids),
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
  console.log(`[server] listening on http://localhost:${port} (db: ${dbPath}, adapters: fake)`);
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
