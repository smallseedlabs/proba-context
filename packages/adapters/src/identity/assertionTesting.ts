import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import { DEFAULT_ACT_AS_AUDIENCES } from './constants.js';

/**
 * Signers that mint Hub act-as assertions for automated checks. Nothing here is a
 * credential of a real deployment.
 */

export interface TokenSigner {
  kid: string;
  jwks: { keys: JWK[] };
  sign(claims: Record<string, unknown>, header?: Record<string, unknown>): Promise<string>;
  writeJwks(dir?: string): Promise<string>;
}

export async function createTokenSigner(kid = `key-${randomUUID().slice(0, 8)}`): Promise<TokenSigner> {
  const { publicKey, privateKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
  const jwks = { keys: [{ ...(await exportJWK(publicKey)), kid, alg: 'EdDSA', use: 'sig' }] };
  return {
    kid,
    jwks,
    sign: (claims, header = {}) =>
      new SignJWT(claims).setProtectedHeader({ alg: 'EdDSA', kid, typ: 'JWT', ...header }).sign(privateKey),
    async writeJwks(dir) {
      const target = dir ?? (await mkdtemp(join(tmpdir(), 'proba-ctx-keys-')));
      const file = join(target, `${kid}.jwks.json`);
      await writeFile(file, JSON.stringify(jwks), { mode: 0o644 });
      return file;
    },
  };
}

export interface AssertionOptions {
  iss?: string;
  aud?: string[];
  sub?: string;
  workspaceId?: string;
  goalId?: string;
  threadId?: string;
  scopes?: string[];
  jti?: string | null;
  iatOffset?: number;
  ttl?: number;
  expOffset?: number;
  nbfOffset?: number;
}

export interface AssertionSigners {
  hub: TokenSigner;
  /** A second signer used to forge assertions with an unknown key. */
  foreign: TokenSigner;
  mintAssertion(options?: AssertionOptions, signer?: TokenSigner): Promise<string>;
}

export async function createAssertionSigners(now: () => Date = () => new Date()): Promise<AssertionSigners> {
  const hub = await createTokenSigner('hub-key-1');
  const foreign = await createTokenSigner('foreign-key-1');
  const seconds = (): number => Math.floor(now().getTime() / 1000);
  return {
    hub,
    foreign,
    async mintAssertion(o = {}, signer = hub) {
      const iat = seconds() + (o.iatOffset ?? 0);
      const claims: Record<string, unknown> = {
        iss: o.iss ?? 'proba-hub',
        aud: o.aud ?? [...DEFAULT_ACT_AS_AUDIENCES],
        sub: o.sub ?? randomUUID(),
        workspaceId: o.workspaceId ?? 'seedbed',
        goalId: o.goalId ?? randomUUID(),
        threadId: o.threadId ?? randomUUID(),
        scopes: o.scopes ?? ['context:build'],
        iat,
        exp: o.expOffset !== undefined ? seconds() + o.expOffset : iat + (o.ttl ?? 120),
      };
      if (o.jti !== null) claims.jti = o.jti ?? randomUUID();
      if (o.nbfOffset !== undefined) claims.nbf = seconds() + o.nbfOffset;
      return signer.sign(claims);
    },
  };
}
