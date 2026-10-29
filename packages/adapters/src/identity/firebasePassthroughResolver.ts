import {
  IdentityRejectedError,
  type IdentityCredentials,
  type IdentityResolver,
  type ResolvedIdentity,
} from '@smallseedlabs/proba-context-core';
import type { FirebaseTokenVerifier } from './firebaseTokenVerifier.js';

export const FIREBASE_PASSTHROUGH_SCOPES = ['context:build'] as const;

/** Thrown when the firebase_passthrough resolver is constructed without being enabled. */
export class FirebasePassthroughDisabledError extends Error {
  constructor() {
    super('firebase_passthrough identity is disabled unless FIREBASE_PROJECT_ID is configured and identity.mode is firebase_passthrough.');
    this.name = 'FirebasePassthroughDisabledError';
  }
}

export interface FirebasePassthroughResolverOptions {
  verifier: FirebaseTokenVerifier;
  /** Must be true; construction is refused otherwise so the mode cannot be half-wired. */
  enabled: boolean;
}

/**
 * Interactive-only identity: verify the caller's Firebase ID token and build an equivalent
 * assertion context from the request body's scope fields. Disabled unless configured.
 */
export class FirebasePassthroughResolver implements IdentityResolver {
  constructor(private readonly options: FirebasePassthroughResolverOptions) {
    if (!options.enabled) throw new FirebasePassthroughDisabledError();
  }

  async resolve(credentials: IdentityCredentials): Promise<ResolvedIdentity> {
    const token = bearerToken(credentials.authorization);
    if (!token) {
      throw new IdentityRejectedError('identity_missing', 'No Firebase ID token was supplied.');
    }
    const identity = await this.options.verifier.verify(token);
    const scope = credentials.scope;
    const workspaceId = scope?.workspaceId?.trim();
    const goalId = scope?.goalId?.trim();
    const threadId = scope?.threadId?.trim();
    if (!workspaceId || !goalId || !threadId) {
      throw new IdentityRejectedError(
        'identity_scope_required',
        'workspaceId, goalId and threadId are required with firebase_passthrough.'
      );
    }
    if (scope?.userId && scope.userId !== identity.subject) {
      throw new IdentityRejectedError('identity_mismatch', 'The request user does not match the Firebase subject.');
    }
    return {
      subject: identity.subject,
      userId: identity.subject,
      workspaceId,
      goalId,
      threadId,
      scopes: [...FIREBASE_PASSTHROUGH_SCOPES],
      // Forward a caller-supplied assertion so Phase-2 HTTP sources can still call upstream when present.
      ...(credentials.actAsAssertion?.trim() ? { actAsAssertion: credentials.actAsAssertion.trim() } : {}),
    };
  }
}

function bearerToken(authorization: string | undefined): string | undefined {
  if (!authorization) return undefined;
  const match = /^Bearer\s+(\S+)$/i.exec(authorization.trim());
  return match?.[1];
}
