/** Shared act-as / context-bridge identity constants (aligned with Hub and audit-api). */

export const ACT_AS_ISSUER = 'proba-hub';
/** Audience this service requires on Hub act-as assertions. */
export const CONTEXT_BRIDGE_AUDIENCE = 'proba-context';
export const CONTEXT_SERVICE_ISSUER = 'proba-context';
export const CONTEXT_HUB_AUDIENCE = 'proba-hub';
export const CONTEXT_READER_ROLE = 'context-reader';

/** Act-as assertion lives at most five minutes (exp − iat). */
export const ACT_AS_ASSERTION_MAX_TTL_SECONDS = 5 * 60;
/** Clock difference tolerated when checking exp, nbf and iat. */
export const CONTEXT_CLOCK_SKEW_SECONDS = 30;

export const MAX_TOKEN_LENGTH = 8192;
export const MAX_JTI_LENGTH = 128;

export const DEFAULT_ACT_AS_AUDIENCES = [
  'proba-context',
  'proba-audit',
  'proba-memory',
  'proba-hub',
] as const;
