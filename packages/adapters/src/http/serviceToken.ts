import { createPrivateKey, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { SignJWT, importJWK, type JWK, type KeyLike } from 'jose';
import type { Clock } from '@smallseedlabs/proba-context-core';

export const CONTEXT_SERVICE_ISSUER = 'proba-context';
export const CONTEXT_SERVICE_SUBJECT = 'context-reader';
/** Bridge service tokens live at most two minutes. */
export const CONTEXT_SERVICE_TOKEN_MAX_TTL_SECONDS = 120;

export type DownstreamAudience = 'proba-audit' | 'proba-memory' | 'proba-hub';

export interface ServiceTokenSigner {
  /** Mints a short-lived EdDSA JWT for the given audience. */
  mint(audience: DownstreamAudience): Promise<string>;
}

export interface PrivateKeyMaterial {
  kid: string;
  /** Node KeyObject or jose KeyLike suitable for SignJWT.sign. */
  key: KeyLike | KeyObject | Uint8Array;
}

/**
 * Loads the bridge's signing key from `CONTEXT_SERVICE_PRIVATE_KEY_FILE`.
 * Accepts a PEM private key (optional sibling `{kid}` via `CONTEXT_SERVICE_KEY_ID`, default `bridge-key-1`)
 * or a JWKS document that includes a private `d` for one Ed25519 key.
 */
export async function loadServicePrivateKey(filePath: string, kid = process.env.CONTEXT_SERVICE_KEY_ID ?? 'bridge-key-1'): Promise<PrivateKeyMaterial> {
  const raw = readFileSync(filePath, 'utf8').trim();
  if (raw.startsWith('{')) {
    const doc = JSON.parse(raw) as { keys?: JWK[] } | JWK;
    const keys = 'keys' in doc && Array.isArray(doc.keys) ? doc.keys : [doc as JWK];
    const match = keys.find((k) => k.kid === kid) ?? keys[0];
    if (!match || match.kty !== 'OKP' || match.crv !== 'Ed25519' || typeof match.d !== 'string') {
      throw new Error(`CONTEXT_SERVICE_PRIVATE_KEY_FILE has no Ed25519 private key (kid ${kid}).`);
    }
    const key = await importJWK({ ...match, alg: 'EdDSA' }, 'EdDSA');
    return { kid: typeof match.kid === 'string' ? match.kid : kid, key };
  }
  const key = createPrivateKey(raw);
  if (key.asymmetricKeyType !== 'ed25519') {
    throw new Error('CONTEXT_SERVICE_PRIVATE_KEY_FILE must be an Ed25519 private key.');
  }
  return { kid, key };
}

export interface CreateServiceTokenSignerOptions {
  material: PrivateKeyMaterial;
  clock: Clock;
  /** Lifetime in seconds, at most {@link CONTEXT_SERVICE_TOKEN_MAX_TTL_SECONDS}. Default 60. */
  ttlSeconds?: number;
}

export function createServiceTokenSigner(options: CreateServiceTokenSignerOptions): ServiceTokenSigner {
  const ttl = Math.min(Math.max(1, options.ttlSeconds ?? 60), CONTEXT_SERVICE_TOKEN_MAX_TTL_SECONDS);
  const { kid, key } = options.material;
  return {
    async mint(audience: DownstreamAudience): Promise<string> {
      const now = Math.floor(options.clock.now().getTime() / 1000);
      return new SignJWT({
        iss: CONTEXT_SERVICE_ISSUER,
        aud: audience,
        sub: CONTEXT_SERVICE_SUBJECT,
        jti: randomUUID(),
      })
        .setProtectedHeader({ alg: 'EdDSA', typ: 'JWT', kid })
        .setIssuedAt(now)
        .setExpirationTime(now + ttl)
        .sign(key);
    },
  };
}
