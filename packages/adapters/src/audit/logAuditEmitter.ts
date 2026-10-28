import type { AuditEmitter, AuditEventInput } from '@smallseedlabs/proba-context-core';

/** Where a log emitter writes: one line per event. */
export interface LineSink {
  write(line: string): void;
}

/** Thrown when a log emitter is created in production, where audit events must reach the audit stream. */
export class LogAuditEmitterRefusedError extends Error {
  constructor() {
    super('The log audit emitter is not allowed when NODE_ENV=production: audit events must go to the Redis stream.');
    this.name = 'LogAuditEmitterRefusedError';
  }
}

/**
 * Writes one JSON line per audit event (ids, action, outcome; never `details` or `content`) to a sink.
 * For running the service on a workstation without Redis. Refused when `NODE_ENV=production`.
 */
export class LogAuditEmitter implements AuditEmitter {
  constructor(
    private readonly sink: LineSink = { write: (line) => process.stdout.write(`${line}\n`) },
    nodeEnv: string | undefined = process.env.NODE_ENV
  ) {
    if (nodeEnv === 'production') throw new LogAuditEmitterRefusedError();
  }

  async emit(event: AuditEventInput): Promise<void> {
    this.sink.write(
      JSON.stringify({
        audit: true,
        eventId: event.eventId,
        traceId: event.traceId,
        action: event.action,
        outcome: event.outcome,
        errorCode: event.errorCode,
        workspaceId: event.workspaceId,
      })
    );
  }
}
