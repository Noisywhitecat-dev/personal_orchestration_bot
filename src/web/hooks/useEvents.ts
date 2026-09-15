import { useEffect, useRef } from 'react';

import type { SseEvent } from '../../shared/contracts.js';

const EVENT_TYPES: SseEvent['type'][] = [
  'task_updated',
  'run_updated',
  'message_added',
  'timeline_appended',
  'usage_updated',
  'budget_updated',
  'system_error',
];

/** Subscribes to /api/events and forwards every parsed event to `onEvent`. */
export function useEvents(onEvent: (event: SseEvent) => void, onReconnect?: () => void): void {
  const eventRef = useRef(onEvent);
  const reconnectRef = useRef(onReconnect);
  eventRef.current = onEvent;
  reconnectRef.current = onReconnect;

  useEffect(() => {
    const source = new EventSource('/api/events');
    let opened = false;
    const handler = (e: MessageEvent<string>) => {
      try {
        eventRef.current(JSON.parse(e.data) as SseEvent);
      } catch {
        // ignore malformed frames
      }
    };
    for (const t of EVENT_TYPES) source.addEventListener(t, handler as EventListener);
    source.addEventListener('open', () => {
      if (opened) reconnectRef.current?.();
      opened = true;
    });
    return () => source.close();
  }, []);
}
