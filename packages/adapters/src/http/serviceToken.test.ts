import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeProtectedHeader, jwtVerify, exportJWK, importSPKI } from 'jose';
import { describe, expect, it } from 'vitest';
import {
  CONTEXT_SERVICE_ISSUER,
  CONTEXT_SERVICE_SUBJECT,
  createServiceTokenSigner,
  loadServicePrivateKey,
} from './serviceToken.js';

describe('service token signer', () => {
  it('mints an EdDSA JWT with the bridge claims', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const dir = mkdtempSync(join(tmpdir(), 'ctx-svc-'));
    const pem = join(dir, 'bridge.private.pem');
    writeFileSync(pem, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    const material = await loadServicePrivateKey(pem, 'bridge-key-1');
    const now = new Date();
    const signer = createServiceTokenSigner({
      material,
      clock: { now: () => now },
      ttlSeconds: 60,
    });
    const token = await signer.mint('proba-memory');
    const header = decodeProtectedHeader(token);
    expect(header.alg).toBe('EdDSA');
    expect(header.kid).toBe('bridge-key-1');

    const spki = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const key = await importSPKI(spki, 'EdDSA');
    const { payload } = await jwtVerify(token, key, {
      issuer: CONTEXT_SERVICE_ISSUER,
      audience: 'proba-memory',
      currentDate: now,
    });
    expect(payload.sub).toBe(CONTEXT_SERVICE_SUBJECT);
    expect(payload.exp! - payload.iat!).toBe(60);
    expect(typeof payload.jti).toBe('string');

    // Public JWKS shape used by upstream verifiers.
    const jwk = await exportJWK(publicKey);
    expect(jwk.kty).toBe('OKP');
  });
});
