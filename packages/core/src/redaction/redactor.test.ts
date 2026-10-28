import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { Redactor, luhnValid } from './redactor.js';

const secretsOnly = new Redactor({ pii: false });
const withPii = new Redactor({ pii: true });

// Built at run time so that no credential-shaped literal sits in the source tree.
const awsKey = ['AKIA', 'ABCDEFGHIJKLMNOP'].join('');
const githubToken = ['ghp', '_', 'a'.repeat(36)].join('');
const apiKey = ['sk', '-', 'live', '_', 'abcdefghijklmnop1234'].join('');
const jwt = ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0', 'abcdefghijklmnopqrstuvwxyz'].join('.');
const googleKey = ['AIza', 'SyA'.padEnd(35, 'x')].join('');
const slackToken = ['xoxb', '-', '1234567890-abcdefghij'].join('');

describe('secrets (always redacted)', () => {
  const cases: Array<[string, string]> = [
    ['aws key', `key ${awsKey} here`],
    ['github token', `use ${githubToken} now`],
    ['api key', `token is ${apiKey}`],
    ['jwt', `Authorization header ${jwt}`],
    ['google key', `maps ${googleKey}`],
    ['slack token', `hook ${slackToken}`],
    ['bearer token', 'Bearer abcdefghijklmnopqrstuvwx'],
    ['private key', '-----BEGIN RSA PRIVATE KEY-----\nMIIEabc\n-----END RSA PRIVATE KEY-----'],
    ['url credentials', 'postgres://admin:hunter22pass@db.internal/app'],
    ['credential assignment', 'password = "correct-horse-battery"'],
  ];

  it.each(cases)('redacts %s with and without PII mode', (_name, input) => {
    for (const redactor of [secretsOnly, withPii]) {
      const result = redactor.redact(input);
      expect(result.text).toContain('[REDACTED:');
      expect(result.redactions.length).toBeGreaterThan(0);
    }
    expect(secretsOnly.redact(input).text).not.toMatch(/AKIA[A-Z0-9]{16}|ghp_a{36}|hunter22pass|correct-horse|sk-live/);
  });

  it('keeps the host of a URL whose credentials were removed', () => {
    expect(secretsOnly.redact('postgres://admin:hunter22pass@db.internal/app').text).toBe(
      'postgres://[REDACTED:url_credentials]@db.internal/app'
    );
  });

  it('never lets a secret survive, wherever it sits in the text', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 40 }), fc.string({ maxLength: 40 }), (before, after) => {
        for (const secret of [awsKey, githubToken, apiKey, jwt, googleKey, slackToken]) {
          const out = secretsOnly.redact(`${before} ${secret} ${after}`).text;
          expect(out).not.toContain(secret);
        }
      }),
      { numRuns: 200 }
    );
  });

  it('is idempotent', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 120 }), (text) => {
        const once = withPii.redact(`${text} ${githubToken} a.b@example.com`).text;
        expect(withPii.redact(once).text).toBe(once);
      }),
      { numRuns: 200 }
    );
  });
});

describe('personal data (only with pii)', () => {
  const email = 'jane.doe@example.com';
  const card = '4111 1111 1111 1111';
  const iban = 'GB82 WEST 1234 5698 7654 32';

  it('redacts email, card, IBAN, SSN and phone when pii is on', () => {
    const text = `mail ${email}, card ${card}, iban ${iban}, ssn 123-45-6789, call +44 20 7946 0958`;
    const out = withPii.redact(text);
    expect(out.text).not.toContain(email);
    expect(out.text).not.toContain('4111');
    expect(out.text).not.toContain('WEST');
    expect(out.text).not.toContain('123-45-6789');
    expect(out.text).not.toContain('7946');
    expect(out.redactions.map((r) => r.type).sort()).toEqual(['card', 'email', 'iban', 'phone', 'ssn']);
  });

  it('leaves personal data alone when pii is off', () => {
    const text = `mail ${email}, card ${card}`;
    expect(secretsOnly.redact(text)).toEqual({ text, redactions: [] });
  });

  it('only treats digit runs that pass the Luhn check as cards', () => {
    expect(luhnValid('4111111111111111')).toBe(true);
    expect(luhnValid('4111111111111112')).toBe(false);
    // A number that fails the check is not a card (the phone rule may still take part of it).
    expect(withPii.redact('order 4111 1111 1111 1112').redactions.map((r) => r.type)).not.toContain('card');
  });

  it('does not mistake a date for a phone number', () => {
    expect(withPii.redact('observed 2026-10-28').text).toBe('observed 2026-10-28');
  });

  it('counts each redaction by type', () => {
    const out = withPii.redact('a@example.com and b@example.org');
    expect(out.redactions).toEqual([{ type: 'email', count: 2 }]);
  });
});
