import { useEffect } from 'react';

import type { SseEvent } from '../../shared/contracts.js';

const EVENT_TYPES: SseEvent['type'][] = [
  'task_updated',
  'run_updated',
  'message_added',
  'timeline_appended',
  'usage_updated',
  'system_error',
];

/** Subscribes to /api/events and forwards every parsed event to `onEvent`. */
export function useEvents(onEvent: (event: SseEvent) => void): void {
  useEffect(() => {
    const source = new EventSource('/api/events');
    const handler = (e: MessageEvent<string>) => {
      try {
        onEvent(JSON.parse(e.data) as SseEvent);
      } catch {
        // ignore malformed frames
      }
    };
    for (const t of EVENT_TYPES) source.addEventListener(t, handler as EventListener);
    return () => source.close();
  }, [onEvent]);
}
