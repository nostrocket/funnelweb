import { describe, test, expect } from 'vitest';
import { normaliseRelayUrl, tryNormaliseRelayUrl, isCanonical } from '../../src/core/relayUrl';

describe('normaliseRelayUrl', () => {
  test('canonicalises wss with default port and trailing slash', () => {
    expect(normaliseRelayUrl('wss://Relay.Example.com:443/'))
      .toBe('wss://relay.example.com');
  });

  test('passes through an already-canonical url', () => {
    expect(normaliseRelayUrl('wss://relay.example.com')).toBe('wss://relay.example.com');
  });

  test('strips trailing slash on bare host', () => {
    expect(normaliseRelayUrl('wss://relay.example.com/')).toBe('wss://relay.example.com');
  });

  test('preserves non-empty path but strips trailing slash', () => {
    expect(normaliseRelayUrl('wss://Relay.Example.com:443/v1/')).toBe('wss://relay.example.com/v1');
  });

  test('strips :80 from ws and lowercases host', () => {
    expect(normaliseRelayUrl('ws://Foo.Bar:80')).toBe('ws://foo.bar');
  });

  test('keeps non-default port', () => {
    expect(normaliseRelayUrl('wss://relay.example.com:8443')).toBe('wss://relay.example.com:8443');
  });

  test('drops query and fragment', () => {
    expect(normaliseRelayUrl('wss://relay.example.com/?x=1#frag')).toBe('wss://relay.example.com');
  });

  test('rejects http scheme', () => {
    expect(() => normaliseRelayUrl('https://relay.example.com')).toThrow();
  });

  test('rejects empty input', () => {
    expect(() => normaliseRelayUrl('')).toThrow();
  });

  test('tryNormaliseRelayUrl returns null on failure', () => {
    expect(tryNormaliseRelayUrl('not a url')).toBeNull();
  });

  test('isCanonical detects non-canonical', () => {
    expect(isCanonical('wss://relay.example.com')).toBe(true);
    expect(isCanonical('wss://Relay.Example.com:443/')).toBe(false);
  });
});
