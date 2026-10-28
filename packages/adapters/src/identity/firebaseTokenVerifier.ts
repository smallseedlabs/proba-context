import {
  createRemoteJWKSet,
  errors as joseErrors,
  jwtVerify,
  type JWTPayload,
  type JWTVerifyGetKey,
} from 'jose';
import { IdentityRejectedError, type Clock } from '@smallseedlabs/proba-context-core';

export const FIREBASE_JWKS_URL =
  'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';

export const firebaseIssuer = (projectId: string): string => `https://securetoken.google.com/${projectId}`;

export interface VerifiedFirebaseIdentity {
  subject: string;
  email: string | null;
  emailVerified: boolean;
  name: string | null;
  provider: string | null;
  authTime: Date;
}

export interface FirebaseVerifierOptions {
  projectId: string;
  /** Key source. Defaults to Google's remote JWKS; tests inject a local key set. */
  keys?: JWTVerifyGetKey;
  clockToleranceSec?: number;
  clock?: Clock;
}

const MAX_SUBJECT_LENGTH = 128;
const MAX_TOKEN_LENGTH = 8192;

const isPositiveNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0;

/**
 * Firebase ID token verification (same checks as audit-api / Hub): RS256 against Google's
 * securetoken JWKS, issuer, audience, auth_time. No service account required.
 */
export class FirebaseTokenVerifier {
  readonly name = 'firebase';
  private readonly projectId: string;
  private readonly keys: JWTVerifyGetKey;
  private readonly tolerance: number;
  private readonly clock: Clock;

  constructor(options: FirebaseVerifierOptions) {
    this.projectId = options.projectId.trim();
    if (!this.projectId) {
      throw new Error('A Firebase project ID (FIREBASE_PROJECT_ID) is required to verify Firebase ID tokens');
    }
    this.keys = options.keys ?? createRemoteJWKSet(new URL(FIREBASE_JWKS_URL));
    this.tolerance = options.clockToleranceSec ?? 5;
    this.clock = options.clock ?? { now: () => new Date() };
  }

  async verify(token: string): Promise<VerifiedFirebaseIdentity> {
    if (typeof token !== 'string' || token.length > MAX_TOKEN_LENGTH || token.split('.').length !== 3) {
      throw new IdentityRejectedError('identity_invalid', 'The Firebase ID token is malformed.');
    }
    const currentDate = this.clock.now();
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, this.keys, {
        algorithms: ['RS256'],
        issuer: firebaseIssuer(this.projectId),
        audience: this.projectId,
        clockTolerance: this.tolerance,
        currentDate,
        requiredClaims: ['exp', 'iat', 'sub', 'auth_time'],
      }));
    } catch (error) {
      if (error instanceof joseErrors.JWTExpired) {
        throw new IdentityRejectedError('identity_expired', 'The Firebase ID token has expired.');
      }
      if (
        !(error instanceof joseErrors.JOSEError) ||
        error instanceof joseErrors.JWKSTimeout ||
        /Expected 200 OK/.test(error.message)
      ) {
        throw error;
      }
      throw new IdentityRejectedError('identity_invalid', 'The Firebase ID token is not valid.');
    }

    const nowSec = Math.floor(currentDate.getTime() / 1000);
    const { sub, iat, auth_time: authTime } = payload as JWTPayload & { auth_time?: unknown };
    if (typeof sub !== 'string' || sub.length === 0 || sub.length > MAX_SUBJECT_LENGTH) {
      throw new IdentityRejectedError('identity_invalid', 'The Firebase ID token has an invalid subject.');
    }
    if (!isPositiveNumber(iat) || iat > nowSec + this.tolerance) {
      throw new IdentityRejectedError('identity_invalid', 'The Firebase ID token was issued in the future.');
    }
    if (!isPositiveNumber(authTime) || authTime > nowSec + this.tolerance) {
      throw new IdentityRejectedError('identity_invalid', 'The Firebase ID token has an invalid auth_time.');
    }
    const claims = payload as JWTPayload & {
      email?: unknown;
      email_verified?: unknown;
      name?: unknown;
      firebase?: { sign_in_provider?: unknown };
    };
    return {
      subject: sub,
      email: typeof claims.email === 'string' && claims.email ? claims.email : null,
      emailVerified: claims.email_verified === true,
      name: typeof claims.name === 'string' && claims.name.trim() ? claims.name.trim() : null,
      provider: typeof claims.firebase?.sign_in_provider === 'string' ? claims.firebase.sign_in_provider : null,
      authTime: new Date(authTime * 1000),
    };
  }
}
