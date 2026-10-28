import { describe, expect, it } from 'vitest';
import { IdentityRejectedError } from '@smallseedlabs/proba-context-core';
import {
  LocalIdentityRefusedError,
  LocalIdentityResolver,
  UnconfiguredIdentityResolver,
  assertLocalIdentityAllowed,
} from './localIdentityResolver.js';

const dev = () => new LocalIdentityResolver(() => 'development');
const bearer = 'Bearer local:user-1:seedbed:goal-1:thread-1';

async function rejection(promise: Promise<unknown>): Promise<IdentityRejectedError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(IdentityRejectedError);
    return err as IdentityRejectedError;
  }
  throw new Error('expected a rejection');
}

describe('LocalIdentityResolver', () => {
  it('accepts Authorization: Bearer local:<userId>:<workspaceId>:<goalId>:<threadId>', async () => {
    expect(await dev().resolve({ authorization: bearer })).toEqual({
      subject: 'user-1',
      userId: 'user-1',
      workspaceId: 'seedbed',
      goalId: 'goal-1',
      threadId: 'thread-1',
      scopes: ['context:build'],
    });
  });

  it('accepts an X-Local-Identity JSON header', async () => {
    const identity = await dev().resolve({
      localIdentity: JSON.stringify({ userId: 'user-1', workspaceId: 'seedbed', goalId: 'goal-1', threadId: 'thread-1' }),
    });
    expect(identity).toMatchObject({ userId: 'user-1', workspaceId: 'seedbed', goalId: 'goal-1', threadId: 'thread-1' });
  });

  it.each([
    ['nothing', {}, 'identity_missing'],
    ['a Firebase-style bearer token', { authorization: 'Bearer eyJhbGciOi.abc.def' }, 'identity_missing'],
    ['too few parts', { authorization: 'Bearer local:a:b:c' }, 'identity_invalid'],
    ['too many parts', { authorization: 'Bearer local:a:b:c:d:e' }, 'identity_invalid'],
    ['an empty part', { authorization: 'Bearer local:a::c:d' }, 'identity_invalid'],
    ['invalid JSON', { localIdentity: '{' }, 'identity_invalid'],
    ['JSON with a missing field', { localIdentity: '{"userId":"a"}' }, 'identity_invalid'],
    ['JSON with an extra field', { localIdentity: '{"userId":"a","workspaceId":"b","goalId":"c","threadId":"d","admin":true}' }, 'identity_invalid'],
    ['ids with unsafe characters', { localIdentity: '{"userId":"a b","workspaceId":"b","goalId":"c","threadId":"d"}' }, 'identity_invalid'],
  ])('rejects %s', async (_name, credentials, code) => {
    expect((await rejection(dev().resolve(credentials))).code).toBe(code);
  });
});

describe('production guard', () => {
  it('refuses to construct a local identity resolver when NODE_ENV=production', () => {
    expect(() => new LocalIdentityResolver(() => 'production')).toThrow(LocalIdentityRefusedError);
    expect(() => assertLocalIdentityAllowed('production')).toThrow(/NODE_ENV=production/);
  });

  it.each(['development', 'test', undefined, ''])('allows NODE_ENV=%s', (env) => {
    expect(() => assertLocalIdentityAllowed(env)).not.toThrow();
  });

  it('rejects at resolve time if the environment became production after construction', async () => {
    let env: string | undefined = 'development';
    const resolver = new LocalIdentityResolver(() => env);
    env = 'production';
    expect((await rejection(resolver.resolve({ authorization: bearer }))).code).toBe('local_identity_refused');
  });

  it('refuses when NODE_ENV is read from the process environment by default', () => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      expect(() => new LocalIdentityResolver()).toThrow(LocalIdentityRefusedError);
    } finally {
      process.env.NODE_ENV = previous;
    }
  });
});

describe('UnconfiguredIdentityResolver', () => {
  it('rejects every request', async () => {
    expect((await rejection(new UnconfiguredIdentityResolver().resolve())).code).toBe('identity_unconfigured');
  });
});
