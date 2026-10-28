import {
  IdentityRejectedError,
  type IdentityCredentials,
  type IdentityResolver,
  type ResolvedIdentity,
} from '@smallseedlabs/proba-context-core';
import { z } from 'zod';

/** Scope granted to a local identity: it may build context and nothing else. */
export const LOCAL_IDENTITY_SCOPES = ['context:build'] as const;

const BEARER_PREFIX = 'Bearer local:';

const idSchema = z.string().min(1).max(200).regex(/^[A-Za-z0-9._-]+$/, 'must use letters, digits, ".", "_" or "-" only');

const localIdentitySchema = z
  .object({
    userId: idSchema,
    workspaceId: idSchema,
    goalId: idSchema,
    threadId: idSchema,
  })
  .strict();

/** Thrown when a local identity resolver is created in production. */
export class LocalIdentityRefusedError extends Error {
  constructor() {
    super('The local identity resolver is not allowed when NODE_ENV=production.');
    this.name = 'LocalIdentityRefusedError';
  }
}

/** Throws {@link LocalIdentityRefusedError} when `nodeEnv` is `production`. */
export function assertLocalIdentityAllowed(nodeEnv: string | undefined): void {
  if (nodeEnv === 'production') throw new LocalIdentityRefusedError();
}

/**
 * Identity for running the service on a workstation or in tests, with no token verification.
 *
 * Accepts either
 *   `Authorization: Bearer local:<userId>:<workspaceId>:<goalId>:<threadId>`
 * or
 *   `X-Local-Identity: {"userId":"...","workspaceId":"...","goalId":"...","threadId":"..."}`.
 *
 * Anyone who can reach the service can claim any identity, so it is refused when `NODE_ENV=production`:
 * the constructor throws, and `resolve` rejects too, in case the environment changes after construction.
 */
export class LocalIdentityResolver implements IdentityResolver {
  constructor(private readonly nodeEnv: () => string | undefined = () => process.env.NODE_ENV) {
    assertLocalIdentityAllowed(nodeEnv());
  }

  async resolve(credentials: IdentityCredentials): Promise<ResolvedIdentity> {
    if (this.nodeEnv() === 'production') {
      throw new IdentityRejectedError('local_identity_refused', 'Local identities are not accepted in production.');
    }
    const fromHeader = credentials.localIdentity;
    const fromBearer = credentials.authorization?.startsWith(BEARER_PREFIX) ? credentials.authorization : undefined;
    if (fromHeader === undefined && fromBearer === undefined) {
      throw new IdentityRejectedError('identity_missing', 'No local identity was supplied.');
    }
    const identity = fromHeader !== undefined ? parseJson(fromHeader) : parseBearer(fromBearer as string);
    // Forward a caller-supplied X-Act-As so Phase-2 HTTP sources can call audit/memory on a workstation.
    if (credentials.actAsAssertion?.trim()) {
      return { ...identity, actAsAssertion: credentials.actAsAssertion.trim() };
    }
    return identity;
  }
}

function toIdentity(raw: unknown): ResolvedIdentity {
  const parsed = localIdentitySchema.safeParse(raw);
  if (!parsed.success) {
    throw new IdentityRejectedError('identity_invalid', 'The local identity is malformed.');
  }
  const { userId, workspaceId, goalId, threadId } = parsed.data;
  return { subject: userId, userId, workspaceId, goalId, threadId, scopes: [...LOCAL_IDENTITY_SCOPES] };
}

function parseJson(value: string): ResolvedIdentity {
  let raw: unknown;
  try {
    raw = JSON.parse(value);
  } catch {
    throw new IdentityRejectedError('identity_invalid', 'The local identity is not valid JSON.');
  }
  return toIdentity(raw);
}

function parseBearer(authorization: string): ResolvedIdentity {
  const parts = authorization.slice(BEARER_PREFIX.length).split(':');
  if (parts.length !== 4) throw new IdentityRejectedError('identity_invalid', 'The local identity is malformed.');
  const [userId, workspaceId, goalId, threadId] = parts;
  return toIdentity({ userId, workspaceId, goalId, threadId });
}

/** Resolver for deployments where no identity verification is configured: every request is refused. */
export class UnconfiguredIdentityResolver implements IdentityResolver {
  async resolve(): Promise<ResolvedIdentity> {
    throw new IdentityRejectedError('identity_unconfigured', 'Identity verification is not configured for this deployment.');
  }
}
