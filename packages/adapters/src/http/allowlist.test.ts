import { describe, expect, it } from 'vitest';
import { assertAllowedBaseUrl, hostKeyFromUrl, isAllowedDownstreamHost } from './allowlist.js';
import { DownstreamHostRefusedError } from './errors.js';

describe('downstream host allow-list', () => {
  it('builds host keys with non-default ports', () => {
    expect(hostKeyFromUrl(new URL('http://proba-memory:3420'))).toBe('proba-memory:3420');
    expect(hostKeyFromUrl(new URL('https://proba-audit'))).toBe('proba-audit');
  });

  it('accepts listed hosts and refuses others', () => {
    const allowed = ['proba-memory:3420', '127.0.0.1:3420'];
    expect(isAllowedDownstreamHost(new URL('http://proba-memory:3420/v1'), allowed)).toBe(true);
    expect(isAllowedDownstreamHost(new URL('http://evil.example/v1'), allowed)).toBe(false);
    expect(() => assertAllowedBaseUrl('http://evil.example', allowed)).toThrow(DownstreamHostRefusedError);
  });

  it('refuses credentials in the URL and non-http schemes', () => {
    expect(() => assertAllowedBaseUrl('http://user:pass@proba-memory:3420', ['proba-memory:3420'])).toThrow(
      DownstreamHostRefusedError
    );
    expect(() => assertAllowedBaseUrl('file:///etc/passwd', ['proba-memory:3420'])).toThrow(DownstreamHostRefusedError);
  });
});
