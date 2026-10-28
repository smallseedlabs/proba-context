import { IdentityRejectedError, type AdminAuthorizer, type AdminRole, type AdminSession } from '@smallseedlabs/proba-context-core';
import type { FirebaseTokenVerifier } from './firebaseTokenVerifier.js';

export interface AccessPolicy {
  /** Lower-case emails that may use admin routes as viewer. */
  allowedEmails: readonly string[];
  /** Lower-case email domains that may use admin routes as viewer. */
  allowedEmailDomains: readonly string[];
  /** Lower-case emails that may use admin routes as admin. */
  adminEmails: readonly string[];
}

export type AdminDenialReason = 'email_required' | 'email_not_verified' | 'not_allowed' | 'token_missing';

/**
 * Firebase + allow-list authorisation for admin routes (same model as audit-api).
 * Empty policy allows nobody. Admin when in adminEmails; otherwise viewer when in allow-list.
 */
export function authorizeAdmin(identity: {
  subject: string;
  email: string | null;
  emailVerified: boolean;
}, policy: AccessPolicy): { ok: true; session: AdminSession } | { ok: false; reason: AdminDenialReason } {
  if (!identity.email) return { ok: false, reason: 'email_required' };
  if (!identity.emailVerified) return { ok: false, reason: 'email_not_verified' };
  const email = identity.email.trim().toLowerCase();
  const domain = email.slice(email.lastIndexOf('@') + 1);
  const admin = policy.adminEmails.includes(email);
  const viewer = policy.allowedEmails.includes(email) || policy.allowedEmailDomains.includes(domain);
  if (!admin && !viewer) return { ok: false, reason: 'not_allowed' };
  const role: AdminRole = admin ? 'admin' : 'viewer';
  return { ok: true, session: { subject: identity.subject, email, role } };
}

export interface FirebaseAdminAuthorizerOptions {
  verifier: FirebaseTokenVerifier;
  policy: AccessPolicy;
}

export class FirebaseAdminAuthorizer implements AdminAuthorizer {
  constructor(private readonly options: FirebaseAdminAuthorizerOptions) {}

  async authorize(authorizationHeader: string | undefined): Promise<AdminSession> {
    if (!authorizationHeader?.trim()) {
      throw new IdentityRejectedError('identity_missing', 'No Firebase ID token was supplied.');
    }
    const match = /^Bearer\s+(\S+)$/i.exec(authorizationHeader.trim());
    if (!match) {
      throw new IdentityRejectedError('identity_invalid', 'Authorization must be a Bearer Firebase ID token.');
    }
    const identity = await this.options.verifier.verify(match[1]!);
    const decision = authorizeAdmin(identity, this.options.policy);
    if (!decision.ok) {
      const messages: Record<AdminDenialReason, string> = {
        email_required: 'A verified email is required.',
        email_not_verified: 'The email address is not verified.',
        not_allowed: 'This account is not on the allow-list.',
        token_missing: 'No Firebase ID token was supplied.',
      };
      throw new IdentityRejectedError(decision.reason, messages[decision.reason]);
    }
    return decision.session;
  }
}

/** Parses a comma-separated email/domain list into lower-case trimmed entries. */
export function parseEmailList(raw: string | undefined): string[] {
  if (!raw?.trim()) return [];
  return raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}
