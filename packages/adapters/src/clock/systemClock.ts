import type { Clock } from '@smallseedlabs/proba-context-core';

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}
