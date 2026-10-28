export type ContextBuildErrorCode =
  /** The request is not a valid `ContextRequest`. */
  | 'invalid_request'
  /** The request's workspace, user, goal or thread differs from the authenticated identity. */
  | 'identity_mismatch'
  /** No template exists for the step type. */
  | 'template_missing'
  /** A source the build cannot do without (policy, task) failed, timed out or is disabled. */
  | 'required_source_failed'
  /** Policy, task and tools alone need more tokens than the budget allows. */
  | 'budget_exceeded_by_required'
  /** The audit trail could not be written; nothing is returned without an audit record. */
  | 'audit_unavailable'
  /** Anything else that went wrong while building. */
  | 'internal_error';

/** A build that cannot produce a packet. The message never contains item text. */
export class ContextBuildError extends Error {
  readonly code: ContextBuildErrorCode;

  constructor(code: ContextBuildErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ContextBuildError';
    this.code = code;
  }
}
