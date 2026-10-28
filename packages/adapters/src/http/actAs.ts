import type { SourceQuery } from '@smallseedlabs/proba-context-core';
import { SourceAdapterError } from './errors.js';

/**
 * Act-as JWT for a downstream call: taken only from the verified identity (never from the request body).
 * Throws {@link SourceAdapterError} with `source_error` when missing.
 */
export function requireActAsAssertion(query: SourceQuery): string {
  const token = query.identity.actAsAssertion?.trim();
  if (!token) {
    throw new SourceAdapterError('source_error', 'No X-Act-As assertion is available for this request.');
  }
  return token;
}

/** `actorId` and `workspaceId` taken only from the verified identity. */
export function scopeParams(query: SourceQuery): { actorId: string; workspaceId: string } {
  return { actorId: query.identity.userId, workspaceId: query.identity.workspaceId };
}
