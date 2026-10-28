import {
  IdentityRejectedError,
  type ActAsAssertionClaims,
  type IdentityCredentials,
  type IdentityResolver,
  type JtiStore,
  type ResolvedIdentity,
} from '@smallseedlabs/proba-context-core';
import type { ActAsAssertionVerifier } from './actAsAssertionVerifier.js';
import type { HubAuthorizePort } from './hubAuthorize.js';

export interface ActAsIdentityResolverOptions {
  verifier: ActAsAssertionVerifier;
  jtiStore: JtiStore;
  authorize: HubAuthorizePort;
}

/**
 * Default identity mode: verify the Hub's act-as assertion (`Authorization: Bearer` or
 * `X-Act-As`), reject replays via the jti store, and confirm user/workspace/goal with Hub authorize.
 */
export class ActAsIdentityResolver implements IdentityResolver {
  constructor(private readonly options: ActAsIdentityResolverOptions) {}

  async resolve(credentials: IdentityCredentials): Promise<ResolvedIdentity> {
    const token = extractAssertion(credentials);
    if (!token) {
      throw new IdentityRejectedError('identity_missing', 'No act-as assertion was supplied.');
    }

    let claims: ActAsAssertionClaims;
    try {
      claims = await this.options.verifier.verify(token);
    } catch (err) {
      if (err instanceof IdentityRejectedError) throw err;
      throw new IdentityRejectedError('act_as_invalid', 'The act-as assertion is not valid.');
    }

    const ttlSeconds = Math.max(1, claims.exp - Math.floor(Date.now() / 1000));
    const firstSighting = await this.options.jtiStore.claim(claims.jti, ttlSeconds);
    if (!firstSighting) {
      throw new IdentityRejectedError('act_as_replayed', 'The act-as assertion has already been used.');
    }

    const decision = await this.options.authorize.authorize({
      userId: claims.sub,
      workspaceId: claims.workspaceId,
      goalId: claims.goalId,
      actAsAssertion: token,
    });
    if (!decision.allowed) {
      throw new IdentityRejectedError('authorize_denied', 'The caller is not authorised for this goal.');
    }

    return {
      subject: claims.sub,
      userId: claims.sub,
      workspaceId: claims.workspaceId,
      goalId: claims.goalId,
      threadId: claims.threadId,
      scopes: [...claims.scopes],
      claims,
      actAsAssertion: token,
    };
  }
}

/** Prefer `X-Act-As`; otherwise take a JWT from `Authorization: Bearer` (Hub ContextClient). */
export function extractAssertion(credentials: IdentityCredentials): string | undefined {
  const fromHeader = credentials.actAsAssertion?.trim();
  if (fromHeader) return fromHeader;
  const auth = credentials.authorization?.trim();
  if (!auth) return undefined;
  const match = /^Bearer\s+(\S+)$/i.exec(auth);
  if (!match) return undefined;
  const token = match[1]!;
  if (token.startsWith('local:')) return undefined;
  if (token.split('.').length !== 3) return undefined;
  return token;
}
