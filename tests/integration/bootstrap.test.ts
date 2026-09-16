import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { startApplicationServer } from '../../src/server/bootstrap.js';
import type { RuntimeStatusResponse } from '../../src/shared/contracts.js';

describe('application server bootstrap', () => {
  it('uses a free loopback port and closes cleanly', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'orchestration-bootstrap-'));
    const runtime = await startApplicationServer({
      host: '127.0.0.1',
      port: 0,
      databasePath: join(directory, 'test.sqlite'),
      env: {},
      log: () => undefined,
    });
    try {
      expect(runtime.url).toBe(`http://127.0.0.1:${runtime.port}`);
      const response = await fetch(`${runtime.url}/api/runtime-status`);
      expect(response.status).toBe(200);
      const status = (await response.json()) as RuntimeStatusResponse;
      expect(status.claude.adapter).toBe('fake');
      expect(status.codex.adapter).toBe('fake');
      expect(status.database).toBe('test.sqlite');
    } finally {
      await runtime.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('reports configured CLI models and effort without invoking either provider', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'orchestration-bootstrap-models-'));
    const runtime = await startApplicationServer({
      host: '127.0.0.1',
      port: 0,
      databasePath: join(directory, 'test.sqlite'),
      env: {
        CLAUDE_ADAPTER: 'cli',
        CLAUDE_MODEL: 'sonnet',
        CLAUDE_EFFORT: 'high',
        CODEX_ADAPTER: 'cli',
        CODEX_MODEL: 'gpt-5.6-sol',
        CODEX_REASONING_EFFORT: 'medium',
      },
      log: () => undefined,
    });
    try {
      const response = await fetch(`${runtime.url}/api/runtime-status`);
      const status = (await response.json()) as RuntimeStatusResponse;
      expect(status.claude).toMatchObject({ model: 'sonnet', effort: 'high' });
      expect(status.codex).toMatchObject({ model: 'gpt-5.6-sol', effort: 'medium' });
    } finally {
      await runtime.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
