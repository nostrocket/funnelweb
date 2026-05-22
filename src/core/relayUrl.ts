import type { RelayUrl } from '../types';

export function normaliseRelayUrl(raw: string): RelayUrl {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new Error('relay url is empty');
  }
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    throw new Error(`invalid relay url: ${raw}`);
  }
  const scheme = parsed.protocol.toLowerCase();
  if (scheme !== 'wss:' && scheme !== 'ws:') {
    throw new Error(`relay scheme must be ws:// or wss://, got ${scheme}`);
  }
  const host = parsed.hostname.toLowerCase();
  if (host === '') throw new Error('relay url missing host');

  let port = parsed.port;
  if ((scheme === 'wss:' && port === '443') || (scheme === 'ws:' && port === '80')) {
    port = '';
  }

  let path = parsed.pathname;
  if (path === '/') path = '';
  else if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);

  const hostPort = port ? `${host}:${port}` : host;
  return `${scheme}//${hostPort}${path}` as RelayUrl;
}

export function tryNormaliseRelayUrl(raw: string): RelayUrl | null {
  try { return normaliseRelayUrl(raw); }
  catch { return null; }
}

export function isCanonical(raw: string): boolean {
  try { return normaliseRelayUrl(raw) === raw; }
  catch { return false; }
}
