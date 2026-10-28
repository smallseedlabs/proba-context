import { createLocalJWKSet } from 'jose';
import { describe, expect, it } from 'vitest';
import { IdentityRejectedError, type JtiStore } from '@smallseedlabs/proba-context-core';
import { ActAsAssertionVerifier } from './actAsAssertionVerifier.js';
import { ActAsIdentityResolver } from './actAsIdentityResolver.js';
import { createAssertionSigners } from './assertionTesting.js';
import { MemoryJtiStore } from './jtiStore.js';
import type { HubAuthorizePort } from './hubAuthorize.js';

const IDS = {
  user: '660e8400-e29b-41d4-a716-446655440001',
  goal: '770e8400-e29b-41d4-a716-446655440002',
  thread: '880e8400-e29b-41d4-a716-446655440003',
};

async function rejection(promise: Promise<unknown>): Promise<IdentityRejectedError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(IdentityRejectedError);
    return err as IdentityRejectedError;
  }
  throw new Error('expected a rejection');
}

function authorizeStub(allowed = true): HubAuthorizePort {
  return {
    authorize: async () => ({ allowed, reason: allowed ? 'ok' : 'denied' }),
  };
}

describe('ActAsAssertionVerifier + ActAsIdentityResolver', () => {
  it('accepts a valid assertion from Authorization Bearer and from X-Act-As', async () => {
    const signers = await createAssertionSigners();
    const verifier = new ActAsAssertionVerifier({ keys: createLocalJWKSet(signers.hub.jwks) });
    const jtiStore = new MemoryJtiStore(undefined, 'test');
    const resolver = new ActAsIdentityResolver({ verifier, jtiStore, authorize: authorizeStub() });

    const token = await signers.mintAssertion({
      sub: IDS.user,
      workspaceId: 'seedbed',
      goalId: IDS.goal,
      threadId: IDS.thread,
      jti: 'jti-1',
    });

    const fromBearer = await resolver.resolve({ authorization: `Bearer ${token}` });
    expect(fromBearer).toMatchObject({
      userId: IDS.user,
      workspaceId: 'seedbed',
      goalId: IDS.goal,
      threadId: IDS.thread,
      actAsAssertion: token,
    });

    const token2 = await signers.mintAssertion({
      sub: IDS.user,
      workspaceId: 'seedbed',
      goalId: IDS.goal,
      threadId: IDS.thread,
      jti: 'jti-2',
    });
    const fromHeader = await resolver.resolve({ actAsAssertion: token2 });
    expect(fromHeader.actAsAssertion).toBe(token2);
  });

  it('rejects a forged assertion (unknown key)', async () => {
    const signers = await createAssertionSigners();
    const verifier = new ActAsAssertionVerifier({ keys: createLocalJWKSet(signers.hub.jwks) });
    const resolver = new ActAsIdentityResolver({
      verifier,
      jtiStore: new MemoryJtiStore(undefined, 'test'),
      authorize: authorizeStub(),
    });
    const forged = await signers.mintAssertion({ sub: IDS.user, goalId: IDS.goal, threadId: IDS.thread }, signers.foreign);
    expect((await rejection(resolver.resolve({ actAsAssertion: forged }))).code).toBe('act_as_invalid');
  });

  it('rejects an expired assertion', async () => {
    const signers = await createAssertionSigners();
    const verifier = new ActAsAssertionVerifier({ keys: createLocalJWKSet(signers.hub.jwks) });
    const resolver = new ActAsIdentityResolver({
      verifier,
      jtiStore: new MemoryJtiStore(undefined, 'test'),
      authorize: authorizeStub(),
    });
    const expired = await signers.mintAssertion({
      sub: IDS.user,
      goalId: IDS.goal,
      threadId: IDS.thread,
      iatOffset: -400,
      expOffset: -100,
    });
    expect((await rejection(resolver.resolve({ actAsAssertion: expired }))).code).toBe('act_as_expired');
  });

  it('rejects a wrong audience', async () => {
    const signers = await createAssertionSigners();
    const verifier = new ActAsAssertionVerifier({ keys: createLocalJWKSet(signers.hub.jwks) });
    const resolver = new ActAsIdentityResolver({
      verifier,
      jtiStore: new MemoryJtiStore(undefined, 'test'),
      authorize: authorizeStub(),
    });
    const wrongAud = await signers.mintAssertion({
      sub: IDS.user,
      goalId: IDS.goal,
      threadId: IDS.thread,
      aud: ['proba-audit', 'proba-memory'],
    });
    expect((await rejection(resolver.resolve({ actAsAssertion: wrongAud }))).code).toBe('act_as_invalid');
  });

  it('rejects a wrong issuer and a not-yet-valid (nbf) assertion', async () => {
    const signers = await createAssertionSigners();
    const verifier = new ActAsAssertionVerifier({ keys: createLocalJWKSet(signers.hub.jwks) });
    const resolver = new ActAsIdentityResolver({
      verifier,
      jtiStore: new MemoryJtiStore(undefined, 'test'),
      authorize: authorizeStub(),
    });
    const wrongIss = await signers.mintAssertion({
      iss: 'proba-context',
      sub: IDS.user,
      goalId: IDS.goal,
      threadId: IDS.thread,
    });
    expect((await rejection(resolver.resolve({ actAsAssertion: wrongIss }))).code).toBe('act_as_invalid');

    const nbf = await signers.mintAssertion({
      sub: IDS.user,
      goalId: IDS.goal,
      threadId: IDS.thread,
      nbfOffset: 120,
    });
    expect((await rejection(resolver.resolve({ actAsAssertion: nbf }))).code).toBe('act_as_invalid');
  });

  it('rejects a replayed jti within its life', async () => {
    const signers = await createAssertionSigners();
    const verifier = new ActAsAssertionVerifier({ keys: createLocalJWKSet(signers.hub.jwks) });
    const jtiStore: JtiStore = new MemoryJtiStore(undefined, 'test');
    const resolver = new ActAsIdentityResolver({ verifier, jtiStore, authorize: authorizeStub() });
    const token = await signers.mintAssertion({
      sub: IDS.user,
      goalId: IDS.goal,
      threadId: IDS.thread,
      jti: 'replay-me',
    });
    await expect(resolver.resolve({ actAsAssertion: token })).resolves.toBeTruthy();
    expect((await rejection(resolver.resolve({ actAsAssertion: token }))).code).toBe('act_as_replayed');
  });

  it('rejects when Hub authorize denies', async () => {
    const signers = await createAssertionSigners();
    const verifier = new ActAsAssertionVerifier({ keys: createLocalJWKSet(signers.hub.jwks) });
    const resolver = new ActAsIdentityResolver({
      verifier,
      jtiStore: new MemoryJtiStore(undefined, 'test'),
      authorize: authorizeStub(false),
    });
    const token = await signers.mintAssertion({ sub: IDS.user, goalId: IDS.goal, threadId: IDS.thread });
    expect((await rejection(resolver.resolve({ actAsAssertion: token }))).code).toBe('authorize_denied');
  });
});
