import type { ActAsAssertionClaims, ContextItem, ContextRequest } from '@smallseedlabs/proba-protocol';

/** Identity of the caller, resolved once per request and passed to every source. */
export interface ResolvedIdentity {
  /** Subject of the assertion (the acting user). */
  subject: string;
  workspaceId: string;
  userId: string;
  goalId: string;
  threadId: string;
  scopes: readonly string[];
  /** The verified claims, when the identity came from an act-as assertion. */
  claims?: ActAsAssertionClaims;
}

/** What every source receives: who is asking, for which request. */
export interface SourceQuery {
  identity: ResolvedIdentity;
  request: ContextRequest;
  /** Aborted when the source's timeout elapses. */
  signal?: AbortSignal;
}

/** What every source returns: citable items, newest or most relevant first. */
export interface SourceResult {
  items: ContextItem[];
}
