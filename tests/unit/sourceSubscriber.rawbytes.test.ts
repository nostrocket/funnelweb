import { describe, test, expect } from 'vitest';
import { finalizeEvent, generateSecretKey, verifyEvent } from 'nostr-tools';
import { extractEventRaw } from '../../src/core/relayConn';

describe('preserve raw bytes (R18)', () => {
  test('extractEventRaw slices the event object byte-for-byte and signature still verifies', () => {
    const sk = generateSecretKey();
    const evt = finalizeEvent({
      kind: 1,
      content: 'hello blaster',
      created_at: Math.floor(Date.now() / 1000),
      tags: [['t', 'demo']]
    }, sk);

    // Build a wire string with NON-canonical key ordering inside the event object.
    // Stringify each field manually so the byte order matches what we serialise.
    const shuffled =
      '{' +
      `"sig":${JSON.stringify(evt.sig)}` + ',' +
      `"id":${JSON.stringify(evt.id)}` + ',' +
      `"pubkey":${JSON.stringify(evt.pubkey)}` + ',' +
      `"created_at":${evt.created_at}` + ',' +
      `"kind":${evt.kind}` + ',' +
      `"tags":${JSON.stringify(evt.tags)}` + ',' +
      `"content":${JSON.stringify(evt.content)}` +
      '}';
    const wire = `["EVENT","sub-id",${shuffled}]`;

    const sliced = extractEventRaw(wire);
    expect(sliced).not.toBeNull();
    expect(sliced).toBe(shuffled);

    const parsed = JSON.parse(sliced!);
    expect(verifyEvent(parsed)).toBe(true);
  });

  test('handles whitespace between top-level array elements', () => {
    const sk = generateSecretKey();
    const evt = finalizeEvent({
      kind: 1, content: 'x',
      created_at: Math.floor(Date.now() / 1000),
      tags: []
    }, sk);
    const evtJson = JSON.stringify(evt);
    const wire = `[ "EVENT" , "sub" ,  ${evtJson} ]`;
    const sliced = extractEventRaw(wire);
    expect(sliced).toBe(evtJson);
    expect(verifyEvent(JSON.parse(sliced!))).toBe(true);
  });
});
