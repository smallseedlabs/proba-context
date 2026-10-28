import { describe, expect, it } from 'vitest';
import { IdentityRejectedError } from '@smallseedlabs/proba-context-core';
import { FirebaseAdminAuthorizer, authorizeAdmin, parseEmailList } from './adminAuth.js';
import { createFakeFirebaseIssuer } from './firebaseTesting.js';
import { FirebaseTokenVerifier } from './firebaseTokenVerifier.js';

describe('authorizeAdmin', () => {
  const policy = {
    allowedEmails: ['viewer@insights.example'],
    allowedEmailDomains: ['partners.example'],
    adminEmails: ['admin@insights.example'],
  };

  it('grants admin and viewer roles from the allow-list', () => {
    expect(
      authorizeAdmin({ subject: 'a', email: 'admin@insights.example', emailVerified: true }, policy)
    ).toEqual({ ok: true, session: { subject: 'a', email: 'admin@insights.example', role: 'admin' } });
    expect(
      authorizeAdmin({ subject: 'v', email: 'viewer@insights.example', emailVerified: true }, policy)
    ).toEqual({ ok: true, session: { subject: 'v', email: 'viewer@insights.example', role: 'viewer' } });
    expect(
      authorizeAdmin({ subject: 'd', email: 'x@partners.example', emailVerified: true }, policy)
    ).toMatchObject({ ok: true, session: { role: 'viewer' } });
  });

  it('denies missing, unverified and unknown emails', () => {
    expect(authorizeAdmin({ subject: 'a', email: null, emailVerified: true }, policy)).toEqual({
      ok: false,
      reason: 'email_required',
    });
    expect(authorizeAdmin({ subject: 'a', email: 'viewer@insights.example', emailVerified: false }, policy)).toEqual({
      ok: false,
      reason: 'email_not_verified',
    });
    expect(authorizeAdmin({ subject: 'a', email: 'other@example.com', emailVerified: true }, policy)).toEqual({
      ok: false,
      reason: 'not_allowed',
    });
  });
});

describe('FirebaseAdminAuthorizer', () => {
  it('resolves an admin session from a Firebase ID token', async () => {
    const issuer = await createFakeFirebaseIssuer('proba-admin');
    const authorizer = new FirebaseAdminAuthorizer({
      verifier: new FirebaseTokenVerifier({ projectId: issuer.projectId, keys: issuer.keys }),
      policy: {
        allowedEmails: ['viewer@insights.example'],
        allowedEmailDomains: [],
        adminEmails: ['admin@insights.example'],
      },
    });
    const token = await issuer.mint({ uid: 'uid-admin', email: 'admin@insights.example' });
    await expect(authorizer.authorize(`Bearer ${token}`)).resolves.toEqual({
      subject: 'uid-admin',
      email: 'admin@insights.example',
      role: 'admin',
    });
  });

  it('rejects a missing token and an unknown email', async () => {
    const issuer = await createFakeFirebaseIssuer('proba-admin');
    const authorizer = new FirebaseAdminAuthorizer({
      verifier: new FirebaseTokenVerifier({ projectId: issuer.projectId, keys: issuer.keys }),
      policy: { allowedEmails: [], allowedEmailDomains: [], adminEmails: ['admin@insights.example'] },
    });
    await expect(authorizer.authorize(undefined)).rejects.toBeInstanceOf(IdentityRejectedError);
    const token = await issuer.mint({ email: 'nobody@example.com' });
    await expect(authorizer.authorize(`Bearer ${token}`)).rejects.toMatchObject({ code: 'not_allowed' });
  });
});

describe('parseEmailList', () => {
  it('splits, trims and lower-cases', () => {
    expect(parseEmailList(' Admin@X.COM , viewer@y.com ')).toEqual(['admin@x.com', 'viewer@y.com']);
    expect(parseEmailList(undefined)).toEqual([]);
  });
});
