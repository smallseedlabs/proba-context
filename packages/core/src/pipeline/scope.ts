import type { ResolvedIdentity } from '../ports/index.js';
import type { ContextItem } from '../protocol.js';

/**
 * Step 4: an item whose `data` names a workspace or a user other than the caller's is out of scope.
 * A present but non-string value counts as a mismatch (fail closed). Items that name neither are kept:
 * sources are already scoped by the identity they were queried with, this is the second check.
 */
export function isInScope(item: ContextItem, identity: Pick<ResolvedIdentity, 'workspaceId' | 'userId'>): boolean {
  const data: unknown = item.data;
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return true;
  const record = data as Record<string, unknown>;
  if ('workspaceId' in record && record.workspaceId !== identity.workspaceId) return false;
  if ('userId' in record && record.userId !== identity.userId) return false;
  return true;
}
