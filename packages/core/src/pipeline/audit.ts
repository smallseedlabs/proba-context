import { buildAuditEvent, generateSpanId, getAuditActionInfo } from '../protocol.js';
import type { AuditEvent, ContextRequest } from '../protocol.js';
import type { ResolvedIdentity } from '../ports/index.js';
import { ContextBuildError } from './errors.js';
import type { PipelineDeps } from './types.js';

export interface AuditFields {
  outcome: AuditEvent['outcome'];
  /** Ids and counts only. Never item text, queries or error text from a source. */
  details?: Record<string, unknown>;
  errorCode?: string;
  errorMessage?: string;
  durationMs?: number;
}

/**
 * Step 8. Writes the `context.*` events of one build. Every event of the build shares the trace id of the
 * request; `context.requested` is the root span and the others are its children. The identity, not the
 * request body, supplies workspace, user, goal and thread.
 */
export class BuildAudit {
  private readonly rootSpanId = generateSpanId();
  private readonly service: string;

  constructor(
    private readonly deps: PipelineDeps,
    private readonly identity: ResolvedIdentity,
    private readonly request: ContextRequest,
    readonly packetId: string
  ) {
    this.service = deps.serviceName ?? 'proba-context';
  }

  /** The ids every event's details may carry. */
  baseDetails(): Record<string, unknown> {
    return {
      packetId: this.packetId,
      workspaceId: this.identity.workspaceId,
      userId: this.identity.userId,
      goalId: this.identity.goalId,
      stepId: this.request.stepId,
      stepType: this.request.stepType,
      configVersion: this.deps.config.version,
    };
  }

  /** Writes one event; throws `audit_unavailable` when the audit trail cannot take it. */
  async emit(action: string, fields: AuditFields): Promise<void> {
    const info = getAuditActionInfo(action);
    const root = action === 'context.requested';
    const event = buildAuditEvent({
      eventId: this.deps.newId?.(),
      traceId: this.request.traceId,
      spanId: root ? this.rootSpanId : undefined,
      ...(root ? {} : { parentSpanId: this.rootSpanId }),
      workspaceId: this.identity.workspaceId,
      userId: this.identity.userId,
      goalId: this.identity.goalId,
      threadId: this.identity.threadId,
      actor: { type: 'service', id: this.service },
      service: this.service,
      action,
      category: info?.category ?? 'data_access',
      target: { type: 'context_packet', id: this.packetId },
      outcome: fields.outcome,
      ...(info ? { riskLevel: info.riskLevel } : {}),
      ...(fields.errorCode !== undefined ? { errorCode: fields.errorCode } : {}),
      ...(fields.errorMessage !== undefined ? { errorMessage: fields.errorMessage } : {}),
      ...(fields.durationMs !== undefined ? { durationMs: fields.durationMs } : {}),
      occurredAt: this.deps.clock.now().toISOString(),
      details: { ...this.baseDetails(), ...fields.details },
    });
    try {
      await this.deps.audit.emit(event);
    } catch (err) {
      throw new ContextBuildError('audit_unavailable', 'The audit trail could not be written.', { cause: err });
    }
  }

  /** Like `emit` for the failure path: never throws, since the build is already failing. */
  async emitQuietly(action: string, fields: AuditFields): Promise<void> {
    try {
      await this.emit(action, fields);
    } catch {
      // The original failure is the one reported.
    }
  }
}
