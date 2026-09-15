import type { IncomingMessage, ServerResponse } from 'node:http';

import type { EventBus } from '../../application/events.js';
import { toPublicEvent } from '../../shared/contracts.js';

const HEARTBEAT_MS = 25_000;

/**
 * Server-Sent Events stream of OrchestrationEvents.
 * Each message: `event: <type>\ndata: <json>\n\n`.
 */
export function attachSse(req: IncomingMessage, res: ServerResponse, bus: EventBus): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.write(': connected\n\n');

  const unsubscribe = bus.subscribe((event) => {
    const safe = toPublicEvent(event);
    res.write(`event: ${safe.type}\ndata: ${JSON.stringify(safe)}\n\n`);
  });

  const heartbeat = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS);
  heartbeat.unref();

  const close = () => {
    clearInterval(heartbeat);
    unsubscribe();
    res.end();
  };
  req.on('close', close);
  req.on('error', close);
}
