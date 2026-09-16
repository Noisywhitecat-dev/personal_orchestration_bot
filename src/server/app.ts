import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';

import type { Orchestrator } from '../application/orchestrator.js';
import { OrchestrationError } from '../domain/errors.js';
import { asProjectId, asTaskId } from '../domain/ids.js';
import { handleApi, HttpError } from './routes/api.js';
import { attachSse } from './events/sse.js';
import type { RuntimeStatusResponse } from '../shared/contracts.js';

export interface AppOptions {
  orchestrator: Orchestrator;
  /** Directory of the built web UI (dist/web). Optional in dev, where Vite serves it. */
  staticDir?: string;
  runtimeStatus?: RuntimeStatusResponse;
}

const MAX_BODY_BYTES = 64 * 1024;

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

/** Builds the HTTP server without listening, so tests can drive it. */
export function createApp(opts: AppOptions): Server {
  const { orchestrator, staticDir } = opts;
  const runtimeStatus =
    opts.runtimeStatus ??
    ({
      claude: {
        adapter: 'fake',
        executable: 'not_required',
        timeoutMs: 600_000,
        model: null,
        effort: null,
      },
      codex: {
        adapter: 'fake',
        executable: 'not_required',
        timeoutMs: 900_000,
        model: null,
        effort: null,
      },
      reviewDiffMaxBytes: 65_536,
      database: 'memory',
      defaultExecutionLimits: {
        maxClaudeRuns: 6,
        maxCodexRuns: 3,
        claudeTokenCeiling: null,
        codexTokenCeiling: null,
        maxClarificationRounds: 3,
        maxReviewRounds: 2,
      },
    } satisfies RuntimeStatusResponse);

  return createServer((req, res) => {
    void handle(req, res).catch((err: unknown) => {
      // Last-resort guard; handle() already maps known errors.
      if (!res.headersSent)
        sendJson(res, 500, { error: { code: 'INTERNAL', message: 'Unexpected server error.' } });
      else res.end();
      console.error('[server] unhandled', err instanceof Error ? err.message : err);
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const method = req.method ?? 'GET';

    if (url.pathname === '/api/events' && method === 'GET') {
      attachSse(req, res, orchestrator.bus);
      return;
    }

    if (url.pathname.startsWith('/api/')) {
      try {
        const body = method === 'POST' ? await readJson(req) : undefined;
        const result = await handleApi({
          method,
          path: url.pathname,
          body,
          orchestrator,
          runtimeStatus,
          ids: { asProjectId, asTaskId },
        });
        sendJson(res, result.status, result.body);
      } catch (err) {
        const mapped = mapError(err);
        sendJson(res, mapped.status, { error: mapped.error });
      }
      return;
    }

    if (staticDir && method === 'GET') {
      serveStatic(res, staticDir, url.pathname);
      return;
    }

    sendJson(res, 404, { error: { code: 'NOT_FOUND', message: 'Not found.' } });
  }
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_BODY_BYTES)
      throw new HttpError(413, 'PAYLOAD_TOO_LARGE', 'Request body too large.');
    chunks.push(buf);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new HttpError(400, 'INVALID_JSON', 'Body is not valid JSON.');
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  });
  res.end(text);
}

function mapError(err: unknown): { status: number; error: { code: string; message: string } } {
  if (err instanceof HttpError)
    return { status: err.status, error: { code: err.code, message: err.message } };
  if (err instanceof OrchestrationError) {
    const status =
      err.code === 'TASK_NOT_FOUND' ||
      err.code === 'PROJECT_NOT_FOUND' ||
      err.code === 'RUN_NOT_FOUND'
        ? 404
        : err.code === 'INVALID_TRANSITION' || err.code === 'APPROVAL_REQUIRED'
          ? 409
          : err.code === 'VALIDATION_FAILED' || err.code === 'INVALID_PROJECT_ROOT'
            ? 400
            : 500;
    return { status, error: { code: err.code, message: err.message } };
  }
  return { status: 500, error: { code: 'INTERNAL', message: 'Unexpected server error.' } };
}

function serveStatic(res: ServerResponse, dir: string, pathname: string): void {
  // Normalize and refuse traversal outside the static dir.
  const rel = normalize(pathname === '/' ? '/index.html' : pathname).replace(/^(\.\.[/\\])+/, '');
  let file = join(dir, rel);
  if (!file.startsWith(dir)) {
    sendJson(res, 403, { error: { code: 'FORBIDDEN', message: 'Forbidden.' } });
    return;
  }
  if (!existsSync(file) || !statSync(file).isFile()) {
    // SPA fallback
    file = join(dir, 'index.html');
    if (!existsSync(file)) {
      sendJson(res, 404, {
        error: { code: 'NOT_FOUND', message: 'UI not built. Run npm run build.' },
      });
      return;
    }
  }
  const type = MIME[extname(file)] ?? 'application/octet-stream';
  res.writeHead(200, { 'content-type': type });
  res.end(readFileSync(file));
}
