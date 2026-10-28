import { DownstreamHostRefusedError } from './errors.js';

/**
 * Returns `hostname` or `hostname:port` in lower case, matching `allowedDownstreamHosts` entries.
 * Default ports (http 80, https 443) are omitted so `host` and `host:443` can both be listed.
 */
export function hostKeyFromUrl(url: URL): string {
  const hostname = url.hostname.toLowerCase();
  const port = url.port;
  if (!port) return hostname;
  const defaultPort = url.protocol === 'https:' ? '443' : url.protocol === 'http:' ? '80' : '';
  if (port === defaultPort) return hostname;
  return `${hostname}:${port}`;
}

/** True when the URL's host (and port, when non-default) is on the allow-list. */
export function isAllowedDownstreamHost(url: URL, allowedHosts: readonly string[]): boolean {
  const key = hostKeyFromUrl(url);
  const lower = allowedHosts.map((h) => h.toLowerCase());
  return lower.includes(key) || lower.includes(url.hostname.toLowerCase());
}

/**
 * Parses `baseUrl`, refuses anything but http(s), and checks the host against the allow-list.
 * Throws {@link DownstreamHostRefusedError} when the host is not listed (SSRF guard).
 */
export function assertAllowedBaseUrl(baseUrl: string, allowedHosts: readonly string[]): URL {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new DownstreamHostRefusedError(baseUrl);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new DownstreamHostRefusedError(hostKeyFromUrl(url));
  }
  if (url.username || url.password) {
    throw new DownstreamHostRefusedError(hostKeyFromUrl(url));
  }
  if (!isAllowedDownstreamHost(url, allowedHosts)) {
    throw new DownstreamHostRefusedError(hostKeyFromUrl(url));
  }
  return url;
}
