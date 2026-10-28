/**
 * Context bridge contract, re-exported from `@smallseedlabs/proba-protocol` so that the rest of
 * the service imports it from one place and the pinned protocol version stays a single dependency.
 */
export type {
  ActAsAssertionClaims,
  AuditEvent,
  AuditEventInput,
  BrainContextAttachedDetails,
  ContextAuditDetails,
  ContextGap,
  ContextItem,
  ContextManifest,
  ContextNeed,
  ContextPacket,
  ContextRequest,
  ContextSection,
  ItemTrust,
  KnownGapCode,
  SectionKind,
  StepType,
} from '@smallseedlabs/proba-protocol';

export {
  ACT_AS_ASSERTION_MAX_TTL_SECONDS,
  KNOWN_GAP_CODES,
  actAsAssertionClaimsSchema,
  auditEventSchema,
  brainContextAttachedDetailsSchema,
  buildAuditEvent,
  generateSpanId,
  getAuditActionInfo,
  contextAuditDetailsSchema,
  contextItemSchema,
  contextNeedSchema,
  contextPacketSchema,
  contextRequestSchema,
  contextSectionSchema,
  itemTrustSchema,
  sectionKindSchema,
  stepTypeSchema,
  validateActAsAssertionClaims,
  validateAuditEvent,
  validateContextNeed,
  validateContextPacket,
  validateContextRequest,
} from '@smallseedlabs/proba-protocol';
