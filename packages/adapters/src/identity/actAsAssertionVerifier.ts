import { errors as joseErrors, decodeProtectedHeader, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';
import {
  ACT_AS_ASSERTION_MAX_TTL_SECONDS,
  actAsAssertionClaimsSchema,
  IdentityRejectedError,
  type ActAsAssertionClaims,
  type Clock,
} from '@smallseedlabs/proba-context-core';
import {
  ACT_AS_ISSUER,
  CONTEXT_BRIDGE_AUDIENCE,
  CONTEXT_CLOCK_SKEW_SECONDS,
  MAX_JTI_LENGTH,
  MAX_TOKEN_LENGTH,
} from './constants.js';

export interface ActAsAssertionVerifierOptions {
  keys: JWTVerifyGetKey;
  clock?: Clock;
}

function checkShape(token: string): void {
  if (typeof token !== 'string' || token.length > MAX_TOKEN_LENGTH || token.split('.').length !== 3) {
    throw new IdentityRejectedError('act_as_invalid', 'The act-as assertion is malformed.');
  }
  let kid: unknown;
  try {
    kid = decodeProtectedHeader(token).kid;
  } catch {
    throw new IdentityRejectedError('act_as_invalid', 'The act-as assertion is malformed.');
  }
  if (typeof kid !== 'string' || kid === '') {
    throw new IdentityRejectedError('act_as_invalid', 'The act-as assertion names no key id.');
  }
}

function mapJoseFailure(error: unknown): never {
  if (error instanceof joseErrors.JWTExpired) {
    throw new IdentityRejectedError('act_as_expired', 'The act-as assertion has expired.');
  }
  if (error instanceof joseErrors.JWTClaimValidationFailed) {
    const claim = (error as joseErrors.JWTClaimValidationFailed).claim;
    if (claim === 'aud') {
      throw new IdentityRejectedError('act_as_invalid', 'The act-as assertion audience is not accepted.');
    }
    if (claim === 'nbf') {
      throw new IdentityRejectedError('act_as_invalid', 'The act-as assertion is not yet valid.');
    }
    if (claim === 'iss') {
      throw new IdentityRejectedError('act_as_invalid', 'The act-as assertion issuer is not accepted.');
    }
  }
  if (!(error instanceof joseErrors.JOSEError)) throw error;
  throw new IdentityRejectedError('act_as_invalid', 'The act-as assertion is not valid.');
}

/**
 * Verifies a Hub-minted act-as assertion for this service: EdDSA, `iss=proba-hub`,
 * `aud` contains `proba-context`, protocol claims, lifetime ≤ 5 minutes, clock skew ≤ 30s.
 */
export class ActAsAssertionVerifier {
  private readonly keys: JWTVerifyGetKey;
  private readonly clock: Clock;

  constructor(options: ActAsAssertionVerifierOptions) {
    this.keys = options.keys;
    this.clock = options.clock ?? { now: () => new Date() };
  }

  async verify(token: string): Promise<ActAsAssertionClaims> {
    checkShape(token);
    const currentDate = this.clock.now();
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, this.keys, {
        algorithms: ['EdDSA'],
        issuer: ACT_AS_ISSUER,
        audience: CONTEXT_BRIDGE_AUDIENCE,
        clockTolerance: CONTEXT_CLOCK_SKEW_SECONDS,
        currentDate,
        requiredClaims: ['exp', 'iat', 'sub', 'jti'],
      }));
    } catch (error) {
      return mapJoseFailure(error);
    }

    const claims = actAsAssertionClaimsSchema.safeParse(payload);
    if (!claims.success) {
      throw new IdentityRejectedError('act_as_invalid', 'The act-as assertion claims are not valid.');
    }
    if (claims.data.jti.length > MAX_JTI_LENGTH) {
      throw new IdentityRejectedError('act_as_invalid', 'The act-as assertion has an invalid jti.');
    }
    if (!claims.data.aud.includes(CONTEXT_BRIDGE_AUDIENCE)) {
      throw new IdentityRejectedError('act_as_invalid', 'The act-as assertion audience is not accepted.');
    }
    if (claims.data.exp - claims.data.iat > ACT_AS_ASSERTION_MAX_TTL_SECONDS) {
      throw new IdentityRejectedError('act_as_invalid', 'The act-as assertion lives longer than five minutes.');
    }
    const nowSec = Math.floor(currentDate.getTime() / 1000);
    if (claims.data.iat > nowSec + CONTEXT_CLOCK_SKEW_SECONDS) {
      throw new IdentityRejectedError('act_as_invalid', 'The act-as assertion was issued in the future.');
    }
    if (claims.data.nbf !== undefined && claims.data.nbf > nowSec + CONTEXT_CLOCK_SKEW_SECONDS) {
      throw new IdentityRejectedError('act_as_invalid', 'The act-as assertion is not yet valid.');
    }
    return claims.data;
  }
}
