import { describe, test, expect, vi, afterEach } from 'vitest';
import { PreviewStore } from '../../src/core/previewStore';
import type { IngestedEvent, RelayUrl } from '../../src/types';

function makeEvent(id: string, kind: number, pubkey = 'pk-1', sourceRelay?: RelayUrl): IngestedEvent {
  return {
    id,
    parsed: { id, pubkey, kind, created_at: 1, content: '', tags: [], sig: '' } as IngestedEvent['parsed'],
    raw: `{"id":"${id}"}`,
    receivedAt: 0,
    ...(sourceRelay ? { sourceRelay } : {})
  };
}

describe('PreviewStore', () => {
  test('add() dedupes by id and tracks matched/unique counts separately', () => {
    const s = new PreviewStore();
    s.add(makeEvent('a', 1));
    s.add(makeEvent('a', 1)); // duplicate
    s.add(makeEvent('b', 1));
    expect(s.size()).toBe(2);
    expect(s.uniqueCount()).toBe(2);
    expect(s.matchedCount()).toBe(3);
    expect(s.snapshot().map(e => e.id)).toEqual(['a', 'b']);
  });

  test('add() retains every unique event (no buffer cap)', () => {
    const s = new PreviewStore();
    for (const id of ['a', 'b', 'c', 'd', 'e']) s.add(makeEvent(id, 1));
    expect(s.size()).toBe(5);
    expect(s.snapshot().map(e => e.id)).toEqual(['a', 'b', 'c', 'd', 'e']);
    // A re-delivery of an existing id is a no-op (already in the seen set).
    s.add(makeEvent('a', 1));
    expect(s.snapshot().map(e => e.id)).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  test('applyFilter() drops non-matching events and rebuilds counts', () => {
    const s = new PreviewStore();
    s.add(makeEvent('a', 1));
    s.add(makeEvent('b', 2));
    s.add(makeEvent('c', 1));
    s.applyFilter({ kinds: [1] });
    expect(s.snapshot().map(e => e.id)).toEqual(['a', 'c']);
    expect(s.uniqueCount()).toBe(2);
    expect(s.matchedCount()).toBe(2);
  });

  test('clear() resets state and notifies subscribers', () => {
    const s = new PreviewStore();
    let calls = 0;
    s.subscribe(() => { calls++; });
    s.add(makeEvent('a', 1));
    s.clear();
    expect(s.size()).toBe(0);
    expect(s.uniqueCount()).toBe(0);
    expect(s.matchedCount()).toBe(0);
    expect(calls).toBeGreaterThanOrEqual(2); // add + clear
  });

  test('snapshot() is an isolated copy', () => {
    const s = new PreviewStore();
    s.add(makeEvent('a', 1));
    const snap = s.snapshot();
    snap.length = 0;
    expect(s.size()).toBe(1);
  });

  test('subscribe() returns an unsubscribe function', () => {
    const s = new PreviewStore();
    let calls = 0;
    const off = s.subscribe(() => { calls++; });
    s.add(makeEvent('a', 1));
    off();
    s.add(makeEvent('b', 1));
    expect(calls).toBe(1);
  });
});

describe('PreviewStore filter enforcement', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  test('add() drops events that fail the active filter', () => {
    const s = new PreviewStore();
    s.setFilter({ kinds: [1] });
    s.add(makeEvent('a', 1));
    s.add(makeEvent('b', 7)); // off-filter
    s.add(makeEvent('c', 1));
    expect(s.snapshot().map(e => e.id)).toEqual(['a', 'c']);
    expect(s.uniqueCount()).toBe(2);
    expect(s.matchedCount()).toBe(2);
  });

  test('add() attributes mismatches per source relay', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const s = new PreviewStore();
    s.setFilter({ kinds: [1] });
    const a = 'wss://a' as RelayUrl;
    const b = 'wss://b' as RelayUrl;
    s.add(makeEvent('e1', 7, 'pk', a));
    s.add(makeEvent('e2', 7, 'pk', a));
    s.add(makeEvent('e3', 7, 'pk', b));
    s.add(makeEvent('e4', 7, 'pk')); // unknown source
    const counts = s.mismatchByRelay();
    expect(counts.get(a)).toBe(2);
    expect(counts.get(b)).toBe(1);
    expect(counts.get('(unknown)' as RelayUrl)).toBe(1);
  });

  test('first off-filter event from a relay logs once; subsequent ones do not', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const s = new PreviewStore();
    s.setFilter({ kinds: [1] });
    const a = 'wss://a' as RelayUrl;
    s.add(makeEvent('e1', 7, 'pk', a));
    s.add(makeEvent('e2', 7, 'pk', a));
    s.add(makeEvent('e3', 7, 'pk', a));
    const fromA = warnSpy.mock.calls.filter(args => args.some(v => typeof v === 'string' && v.includes('wss://a')));
    expect(fromA.length).toBe(1);
  });

  test('applyFilter() resets the per-relay mismatch counter', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const s = new PreviewStore();
    s.setFilter({ kinds: [1] });
    const a = 'wss://a' as RelayUrl;
    s.add(makeEvent('e1', 7, 'pk', a));
    expect(s.mismatchByRelay().get(a)).toBe(1);
    s.applyFilter({ kinds: [7] });
    expect(s.mismatchByRelay().size).toBe(0);
  });

  test('clear() resets the mismatch counter', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const s = new PreviewStore();
    s.setFilter({ kinds: [1] });
    const a = 'wss://a' as RelayUrl;
    s.add(makeEvent('e1', 7, 'pk', a));
    expect(s.mismatchByRelay().get(a)).toBe(1);
    s.clear();
    expect(s.mismatchByRelay().size).toBe(0);
  });

  test('add() with no active filter accepts all events', () => {
    const s = new PreviewStore();
    s.add(makeEvent('a', 1));
    s.add(makeEvent('b', 7));
    expect(s.size()).toBe(2);
    expect(s.mismatchByRelay().size).toBe(0);
  });
});

describe('PreviewStore contributor tracking', () => {
  test('contributorCount() reports distinct source relays for matched events', () => {
    const s = new PreviewStore();
    const a = 'wss://a' as RelayUrl;
    const b = 'wss://b' as RelayUrl;
    s.add(makeEvent('e1', 1, 'pk', a));
    s.add(makeEvent('e2', 1, 'pk', a)); // same relay, different id
    s.add(makeEvent('e3', 1, 'pk', a)); // duplicate id from same relay
    s.add(makeEvent('e4', 1, 'pk', b));
    s.add(makeEvent('e5', 1, 'pk'));    // unknown source — ignored
    expect(s.contributorCount()).toBe(2);
  });

  test('off-filter events do not bump contributorCount', () => {
    const s = new PreviewStore();
    s.setFilter({ kinds: [1] });
    const a = 'wss://a' as RelayUrl;
    s.add(makeEvent('e1', 7, 'pk', a)); // mismatched kind
    expect(s.contributorCount()).toBe(0);
  });

  test('applyFilter() recomputes contributors from survivors', () => {
    const s = new PreviewStore();
    const a = 'wss://a' as RelayUrl;
    const b = 'wss://b' as RelayUrl;
    s.add(makeEvent('e1', 1, 'pk', a));
    s.add(makeEvent('e2', 7, 'pk', b));
    expect(s.contributorCount()).toBe(2);
    s.applyFilter({ kinds: [1] });
    expect(s.contributorCount()).toBe(1);
  });

  test('clear() resets contributors', () => {
    const s = new PreviewStore();
    const a = 'wss://a' as RelayUrl;
    s.add(makeEvent('e1', 1, 'pk', a));
    expect(s.contributorCount()).toBe(1);
    s.clear();
    expect(s.contributorCount()).toBe(0);
  });
});
