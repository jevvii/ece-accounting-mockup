import { todayInManila } from './dates';

export interface Clock {
  nowIso: string;
  today: string;
  newId(prefix: string): string;
}

export function createSystemClock(): Clock {
  let counter = 0;
  return {
    get nowIso() {
      return new Date().toISOString();
    },
    get today() {
      return todayInManila(new Date());
    },
    newId(prefix: string) {
      counter += 1;
      return `${prefix}-${Date.now().toString(36)}-${counter.toString(36)}`;
    },
  };
}

export interface FixedClockOptions {
  nowIso: string;
  today: string;
  seed?: string;
}

/** Deterministic clock/ID generator for seeds and tests. */
export function createFixedClock({ nowIso, today, seed = 'fixture' }: FixedClockOptions): Clock {
  let counter = 0;
  return {
    nowIso,
    today,
    newId(prefix: string) {
      counter += 1;
      return `${prefix}-${seed}-${String(counter).padStart(5, '0')}`;
    },
  };
}

export function createCountingIds(seed = 'fixture'): (prefix: string) => string {
  let counter = 0;
  return (prefix: string) => {
    counter += 1;
    return `${prefix}-${seed}-${String(counter).padStart(5, '0')}`;
  };
}
