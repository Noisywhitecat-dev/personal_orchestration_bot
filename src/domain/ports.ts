import type { IsoTimestamp } from './ids.js';

/** Injected so tests are deterministic. */
export interface Clock {
  now(): IsoTimestamp;
}

export interface IdGenerator {
  next(): string;
}

export const systemClock: Clock = {
  now: () => new Date().toISOString(),
};

/** Deterministic clock for tests: each call advances by `stepMs`. */
export class FixedClock implements Clock {
  private current: number;

  constructor(
    start: string | number = '2026-01-01T00:00:00.000Z',
    private readonly stepMs = 1000,
  ) {
    this.current = typeof start === 'number' ? start : Date.parse(start);
  }

  now(): IsoTimestamp {
    const value = new Date(this.current).toISOString();
    this.current += this.stepMs;
    return value;
  }
}

/** Deterministic sequential ID generator for tests. */
export class SequentialIdGenerator implements IdGenerator {
  private counter = 0;

  constructor(private readonly prefix = 'id') {}

  next(): string {
    this.counter += 1;
    return `${this.prefix}-${String(this.counter).padStart(4, '0')}`;
  }
}
