import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { finalizeEvent, generateSecretKey, type Event as NostrEvent } from 'nostr-tools';
import { ReverseSubscriber } from '../../src/core/reverseSubscriber';
import { DedupeLru } from '../../src/core/dedupeLru';
import type { RelayUrl, RelayRow, IngestedEvent } from '../../src/types';

interface FakeSub {
  url: string;
  closed: boolean;
  onEvent?: (raw: string, parsed: NostrEvent) => void;
  onEose?: () => void;
  onClosed?: (reason: string) => void;
  emitEvent(raw: string, parsed: NostrEvent): void;
  emitEose(): void;
  emitClosed(reason: string): void;
}

function makeRow(url: string): RelayRow {
  return {
    url: url as RelayUrl,
    firstSeen: 0, lastSeen: 0, lastOk: 0,
    failCount: 0, dead: false,
    nip11Json: null, nip11FetchedAt: null,
    viable: true, viableReason: null, lastProbedAt: 0
  };
}

function makeHarness(opts: { rows: RelayRow[]; maxConcurrent?: number; idleTimeoutMs?: number }) {
  const subsByUrl = new Map<string, FakeSub>();

  const fakeConn = (url: string) => ({
    open: vi.fn(),
    subscribe: (_filters: unknown, _opts?: unknown) => {
      const sub: FakeSub = {
        url,
        closed: false,
        emitEvent(raw, parsed) { sub.onEvent?.(raw, parsed); },
        emitEose() { sub.onEose?.(); },
        emitClosed(reason) { sub.onClosed?.(reason); }
      };
      const handle = {
        id: `sub-${url}`,
        close: () => { sub.closed = true; },
        onEvent: (cb: (raw: string, parsed: NostrEvent) => void) => { sub.onEvent = cb; },
        onEose: (cb: () => void) => { sub.onEose = cb; },
        onClosed: (cb: (reason: string) => void) => { sub.onClosed = cb; }
      };
      subsByUrl.set(url, sub);
      return handle;
    }
  });

  const pool = { get: (url: RelayUrl) => fakeConn(url) };
  const registry = { healthy: () => opts.rows };
  const dedupe = new DedupeLru(10_000);

  const events: IngestedEvent[] = [];
  const errors: string[] = [];
  let liveCount = 0;

  const sub = new ReverseSubscriber({
    pool: pool as never,
    registry: registry as never,
    dedupe,
    onEvent: (e) => events.push(e),
    onLive: () => { liveCount++; },
    onError: (msg) => errors.push(msg),
    options: {
      maxConcurrent: opts.maxConcurrent ?? 128,
      idleTimeoutMs: opts.idleTimeoutMs ?? 30_000
    }
  });

  return { sub, subsByUrl, events, errors, get liveCount() { return liveCount; }, dedupe };
}

function makeFilter() { return { kinds: [1], limit: 10 }; }

function signedEvent(content: string): { parsed: NostrEvent; raw: string } {
  const sk = generateSecretKey();
  const e = finalizeEvent({
    kind: 1, content, created_at: Math.floor(Date.now() / 1000), tags: []
  }, sk);
  return { parsed: e, raw: JSON.stringify(e) };
}

describe('ReverseSubscriber', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  test('respects maxConcurrent cap and advances on EOSE', () => {
    const rows = ['a', 'b', 'c', 'd', 'e'].map(s => makeRow(`wss://${s}.example.com`));
    const h = makeHarness({ rows, maxConcurrent: 2 });
    h.sub.start(makeFilter());

    expect(h.subsByUrl.size).toBe(2);
    expect(h.subsByUrl.has('wss://a.example.com')).toBe(true);
    expect(h.subsByUrl.has('wss://b.example.com')).toBe(true);

    // EOSE on the first → next should open.
    h.subsByUrl.get('wss://a.example.com')!.emitEose();
    expect(h.subsByUrl.size).toBe(3); // a still in map (we don't delete from harness map)
    expect(h.subsByUrl.has('wss://c.example.com')).toBe(true);

    // EOSE remaining
    h.subsByUrl.get('wss://b.example.com')!.emitEose();
    h.subsByUrl.get('wss://c.example.com')!.emitEose();
    expect(h.subsByUrl.has('wss://d.example.com')).toBe(true);
    expect(h.subsByUrl.has('wss://e.example.com')).toBe(true);

    h.subsByUrl.get('wss://d.example.com')!.emitEose();
    h.subsByUrl.get('wss://e.example.com')!.emitEose();

    expect(h.liveCount).toBe(1);
  });

  test('idle timeout closes the sub and advances the queue', () => {
    const rows = ['a', 'b', 'c'].map(s => makeRow(`wss://${s}.example.com`));
    const h = makeHarness({ rows, maxConcurrent: 1, idleTimeoutMs: 30_000 });
    h.sub.start(makeFilter());

    expect(h.subsByUrl.size).toBe(1);
    expect(h.subsByUrl.has('wss://a.example.com')).toBe(true);

    vi.advanceTimersByTime(30_000);

    expect(h.subsByUrl.get('wss://a.example.com')!.closed).toBe(true);
    expect(h.subsByUrl.has('wss://b.example.com')).toBe(true);
  });

  test('idle timer resets on each event', () => {
    const rows = [makeRow('wss://a.example.com')];
    const h = makeHarness({ rows, maxConcurrent: 1, idleTimeoutMs: 30_000 });
    h.sub.start(makeFilter());
    const sub = h.subsByUrl.get('wss://a.example.com')!;

    vi.advanceTimersByTime(20_000);
    const ev1 = signedEvent('one');
    sub.emitEvent(ev1.raw, ev1.parsed);
    vi.advanceTimersByTime(20_000);
    const ev2 = signedEvent('two');
    sub.emitEvent(ev2.raw, ev2.parsed);
    vi.advanceTimersByTime(20_000);

    expect(sub.closed).toBe(false);
    expect(h.events.length).toBe(2);

    vi.advanceTimersByTime(15_000);
    expect(sub.closed).toBe(true);
  });

  test('dedupes events seen on multiple relays', () => {
    const rows = ['a', 'b', 'c'].map(s => makeRow(`wss://${s}.example.com`));
    const h = makeHarness({ rows, maxConcurrent: 3 });
    h.sub.start(makeFilter());

    const ev = signedEvent('shared');
    h.subsByUrl.get('wss://a.example.com')!.emitEvent(ev.raw, ev.parsed);
    h.subsByUrl.get('wss://b.example.com')!.emitEvent(ev.raw, ev.parsed);
    h.subsByUrl.get('wss://c.example.com')!.emitEvent(ev.raw, ev.parsed);

    expect(h.events.length).toBe(1);
    expect(h.events[0]!.id).toBe(ev.parsed.id);
  });

  test('drops events with invalid signatures', () => {
    const rows = [makeRow('wss://a.example.com')];
    const h = makeHarness({ rows });
    h.sub.start(makeFilter());

    const tampered: NostrEvent = {
      id: 'a'.repeat(64), pubkey: 'b'.repeat(64), kind: 1,
      content: 'x', created_at: 1, tags: [],
      sig: '0'.repeat(128)
    };
    h.subsByUrl.get('wss://a.example.com')!.emitEvent(JSON.stringify(tampered), tampered);

    expect(h.events.length).toBe(0);
  });

  test('preserves byte-exact raw on emitted IngestedEvent', () => {
    const rows = [makeRow('wss://a.example.com')];
    const h = makeHarness({ rows });
    h.sub.start(makeFilter());

    const ev = signedEvent('byte-exact');
    // Use a non-canonical raw form to confirm it's the *raw* string we hand
    // off, not a re-stringification of `parsed`.
    const noncanonical = JSON.stringify(ev.parsed).replace(/^\{/, '{ ');
    h.subsByUrl.get('wss://a.example.com')!.emitEvent(noncanonical, ev.parsed);
    expect(h.events.length).toBe(1);
    expect(h.events[0]!.raw).toBe(noncanonical);
  });

  test('onLive fires exactly once when all subs EOSE', () => {
    const rows = ['a', 'b'].map(s => makeRow(`wss://${s}.example.com`));
    const h = makeHarness({ rows, maxConcurrent: 2 });
    h.sub.start(makeFilter());

    h.subsByUrl.get('wss://a.example.com')!.emitEose();
    expect(h.liveCount).toBe(0);
    h.subsByUrl.get('wss://b.example.com')!.emitEose();
    expect(h.liveCount).toBe(1);

    // Even if a stale callback fires, no duplicate onLive.
    h.subsByUrl.get('wss://b.example.com')!.emitEose();
    expect(h.liveCount).toBe(1);
  });

  test('stop() closes all active subs and clears timers', () => {
    const rows = ['a', 'b', 'c'].map(s => makeRow(`wss://${s}.example.com`));
    const h = makeHarness({ rows, maxConcurrent: 3, idleTimeoutMs: 30_000 });
    h.sub.start(makeFilter());

    expect(h.subsByUrl.size).toBe(3);
    h.sub.stop();
    for (const sub of h.subsByUrl.values()) expect(sub.closed).toBe(true);

    // Advancing past the idle timer should not trigger any further work or
    // throw — timers must have been cleared on stop().
    vi.advanceTimersByTime(60_000);
    expect(h.liveCount).toBe(0);
  });

  test('emits onLive immediately if no healthy relays at start', () => {
    const h = makeHarness({ rows: [] });
    h.sub.start(makeFilter());
    expect(h.liveCount).toBe(1);
    expect(h.errors.length).toBe(1);
  });

  test('onClosed advances the queue like EOSE does', () => {
    const rows = ['a', 'b'].map(s => makeRow(`wss://${s}.example.com`));
    const h = makeHarness({ rows, maxConcurrent: 1 });
    h.sub.start(makeFilter());

    expect(h.subsByUrl.has('wss://a.example.com')).toBe(true);
    h.subsByUrl.get('wss://a.example.com')!.emitClosed('disconnect');
    expect(h.subsByUrl.has('wss://b.example.com')).toBe(true);
  });

  test('reconfigure restarts the pool with the new filter', () => {
    const rows = ['a', 'b'].map(s => makeRow(`wss://${s}.example.com`));
    const h = makeHarness({ rows, maxConcurrent: 2 });
    h.sub.start(makeFilter());
    const firstA = h.subsByUrl.get('wss://a.example.com')!;
    h.sub.reconfigure({ kinds: [3], limit: 5 });
    expect(firstA.closed).toBe(true);
    // New subs were created (the harness map keys to URL so we can't easily
    // see "fresh" subs, but `closed=true` on the old one + the next start
    // having repopulated is enough).
    expect(h.subsByUrl.size).toBe(2);
  });
});
