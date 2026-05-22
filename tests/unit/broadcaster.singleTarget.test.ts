import { describe, test, expect, vi } from 'vitest';
import { Broadcaster } from '../../src/core/broadcaster';
import type { IngestedEvent, RelayUrl, RelayRow, PublishOutcome, Nip11Doc } from '../../src/types';

interface FakeConn {
  publish(raw: string, id: string): { promise: Promise<PublishOutcome>; cancel: () => void };
  onNotice(cb: (text: string) => void): () => void;
}

function makeConn(publish: FakeConn['publish']): FakeConn & { emitNotice: (t: string) => void } {
  const listeners = new Set<(text: string) => void>();
  return {
    publish,
    onNotice: (cb) => { listeners.add(cb); return () => { listeners.delete(cb); }; },
    emitNotice: (t) => { for (const cb of listeners) cb(t); }
  };
}

function makeRelayRow(url: string): RelayRow {
  return {
    url: url as RelayUrl,
    firstSeen: 0, lastSeen: 0, lastOk: 0,
    failCount: 0, dead: false,
    nip11Json: null, nip11FetchedAt: null,
    viable: true, viableReason: null, lastProbedAt: 0
  };
}

function makeEvent(id: string, raw = `{"id":"${id}"}`): IngestedEvent {
  return {
    id,
    parsed: { id, pubkey: 'pk', kind: 1, created_at: 1, content: '', tags: [], sig: '' } as IngestedEvent['parsed'],
    raw,
    receivedAt: 0
  };
}

function makeRegistry(rows: RelayRow[], opts: {
  cachedNip11?: (url: RelayUrl) => Nip11Doc | null;
  onSuccess?: (url: RelayUrl) => void;
  onFailure?: (url: RelayUrl, reason: string) => void;
  onViable?: (url: RelayUrl, viable: boolean, reason: string) => void;
} = {}) {
  return {
    healthy: () => rows,
    all: () => rows,
    cachedNip11: (url: RelayUrl) => opts.cachedNip11 ? opts.cachedNip11(url) : null,
    nip11: async () => null,
    markSuccess: async (url: RelayUrl) => { opts.onSuccess?.(url); },
    markFailure: async (url: RelayUrl, reason: string) => { opts.onFailure?.(url, reason); },
    markViable: async (url: RelayUrl, viable: boolean, reason: string) => { opts.onViable?.(url, viable, reason); },
    subscribe: () => () => undefined
  };
}

function makePool(connFor: (url: RelayUrl) => FakeConn) {
  return {
    get: (url: RelayUrl) => connFor(url),
    snapshot: () => [],
    isPinned: () => false,
    releaseIfNotPinned: () => true
  };
}

describe('Broadcaster.broadcastBatchToOne', () => {
  test('publishes every event to exactly the destination URL in order', async () => {
    const dest = 'wss://dest.example.com' as RelayUrl;
    const seen: { url: string; raw: string; id: string }[] = [];
    const conn = makeConn((raw, id) => {
      seen.push({ url: dest, raw, id });
      return { promise: Promise.resolve<PublishOutcome>({ kind: 'ok' }), cancel: () => undefined };
    });
    const b = new Broadcaster({
      pool: makePool(() => conn) as never,
      registry: makeRegistry([makeRelayRow(dest)]) as never,
      onLog: vi.fn(),
      onCounter: vi.fn()
    });

    const events = [makeEvent('e1'), makeEvent('e2'), makeEvent('e3')];
    await b.broadcastBatchToOne(dest, events);

    expect(seen.map(s => s.id)).toEqual(['e1', 'e2', 'e3']);
    expect(seen.every(s => s.url === dest)).toBe(true);
  });

  test('does not publish to any other relay', async () => {
    const dest = 'wss://dest.example.com' as RelayUrl;
    const other = 'wss://other.example.com' as RelayUrl;
    const destPub = vi.fn(() => ({ promise: Promise.resolve<PublishOutcome>({ kind: 'ok' }), cancel: () => undefined }));
    const otherPub = vi.fn(() => ({ promise: Promise.resolve<PublishOutcome>({ kind: 'ok' }), cancel: () => undefined }));
    const destConn = makeConn(destPub);
    const otherConn = makeConn(otherPub);
    const b = new Broadcaster({
      pool: makePool(url => url === dest ? destConn : otherConn) as never,
      // Registry has many "healthy" rows but broadcastBatchToOne should ignore them.
      registry: makeRegistry([makeRelayRow(dest), makeRelayRow(other)]) as never,
      onLog: vi.fn(),
      onCounter: vi.fn()
    });

    await b.broadcastBatchToOne(dest, [makeEvent('e1')]);
    expect(destPub).toHaveBeenCalledTimes(1);
    expect(otherPub).not.toHaveBeenCalled();
  });

  test('preserves byte-exact raw bytes through to conn.publish', async () => {
    const dest = 'wss://dest.example.com' as RelayUrl;
    const calls: { raw: string }[] = [];
    const conn = makeConn((raw) => {
      calls.push({ raw });
      return { promise: Promise.resolve<PublishOutcome>({ kind: 'ok' }), cancel: () => undefined };
    });
    const b = new Broadcaster({
      pool: makePool(() => conn) as never,
      registry: makeRegistry([makeRelayRow(dest)]) as never,
      onLog: vi.fn(),
      onCounter: vi.fn()
    });
    const noncanonical = '{ "sig":"abc","id":"e1","pubkey":"x","created_at":1,"kind":1,"tags":[],"content":"" }';
    await b.broadcastBatchToOne(dest, [makeEvent('e1', noncanonical)]);
    expect(calls[0]!.raw).toBe(noncanonical);
  });

  test('empty batch is a no-op', async () => {
    const dest = 'wss://dest.example.com' as RelayUrl;
    const pub = vi.fn();
    const conn = makeConn(pub as never);
    const b = new Broadcaster({
      pool: makePool(() => conn) as never,
      registry: makeRegistry([makeRelayRow(dest)]) as never,
      onLog: vi.fn(),
      onCounter: vi.fn()
    });
    await b.broadcastBatchToOne(dest, []);
    expect(pub).not.toHaveBeenCalled();
  });

  test('honours destination NIP-11 max_message_length and logs permanent oversize', async () => {
    const dest = 'wss://tight.example.com' as RelayUrl;
    const pub = vi.fn();
    const conn = makeConn(pub as never);
    const logged: { outcome: string; reason: string | null }[] = [];
    const b = new Broadcaster({
      pool: makePool(() => conn) as never,
      registry: makeRegistry([makeRelayRow(dest)], {
        cachedNip11: () => ({ limitation: { max_message_length: 32 } })
      }) as never,
      onLog: (e) => logged.push({ outcome: e.outcome, reason: e.reason }),
      onCounter: vi.fn()
    });
    const big = makeEvent('big', `{"id":"big","payload":"${'x'.repeat(200)}"}`);
    await b.broadcastBatchToOne(dest, [big]);
    expect(pub).not.toHaveBeenCalled();
    expect(logged.some(e => e.outcome === 'permanent' && e.reason?.startsWith('oversize:'))).toBe(true);
  });

  test('marks destination success on OK outcome', async () => {
    const dest = 'wss://dest.example.com' as RelayUrl;
    const successCalls: string[] = [];
    const conn = makeConn(() => ({ promise: Promise.resolve<PublishOutcome>({ kind: 'ok' }), cancel: () => undefined }));
    const b = new Broadcaster({
      pool: makePool(() => conn) as never,
      registry: makeRegistry([makeRelayRow(dest)], {
        onSuccess: (u) => successCalls.push(u)
      }) as never,
      onLog: vi.fn(),
      onCounter: vi.fn()
    });
    await b.broadcastBatchToOne(dest, [makeEvent('e1')]);
    expect(successCalls).toEqual([dest]);
  });

  test('resolves even if destination returns transient (unreachable case)', async () => {
    const dest = 'wss://dead.example.com' as RelayUrl;
    const conn = makeConn(() => ({
      promise: Promise.resolve<PublishOutcome>({ kind: 'transient', reason: 'conn-dead' }),
      cancel: () => undefined
    }));
    const b = new Broadcaster({
      pool: makePool(() => conn) as never,
      registry: makeRegistry([makeRelayRow(dest)]) as never,
      onLog: vi.fn(),
      onCounter: vi.fn()
    });
    // Should resolve, not hang.
    const r = await b.broadcastBatchToOne(dest, [makeEvent('e1'), makeEvent('e2')]);
    expect(r).toEqual({ ok: 0, duplicate: 0, transient: 2, permanent: 0, oversize: 0 });
  });

  test('dispatches in index order up to concurrency cap and continues as ACKs land', async () => {
    const dest = 'wss://dest.example.com' as RelayUrl;
    const resolvers: ((o: PublishOutcome) => void)[] = [];
    const dispatched: string[] = [];
    const conn = makeConn((_raw, id) => {
      dispatched.push(id);
      let resolve!: (o: PublishOutcome) => void;
      const promise = new Promise<PublishOutcome>(r => { resolve = r; });
      resolvers.push(resolve);
      return { promise, cancel: () => undefined };
    });
    const concurrency = 2;
    const b = new Broadcaster({
      pool: makePool(() => conn) as never,
      registry: makeRegistry([makeRelayRow(dest)]) as never,
      options: { singleTargetConcurrency: concurrency },
      onLog: vi.fn(),
      onCounter: vi.fn()
    });

    const events = [makeEvent('e1'), makeEvent('e2'), makeEvent('e3'), makeEvent('e4')];
    const done = b.broadcastBatchToOne(dest, events);
    // Let the worker pool spin up and dispatch its first batch.
    await Promise.resolve();
    expect(dispatched).toEqual(['e1', 'e2']);
    expect(resolvers).toHaveLength(2);

    // Resolve one — a worker should pick up the next event.
    resolvers[0]!({ kind: 'ok' });
    await Promise.resolve();
    await Promise.resolve();
    expect(dispatched).toEqual(['e1', 'e2', 'e3']);

    resolvers[1]!({ kind: 'ok' });
    resolvers[2]!({ kind: 'ok' });
    await Promise.resolve();
    await Promise.resolve();
    expect(dispatched).toEqual(['e1', 'e2', 'e3', 'e4']);
    resolvers[3]!({ kind: 'ok' });
    await done;
  });

  test('warns once when destination NOTICE looks like rate-limiting', async () => {
    const dest = 'wss://throttled.example.com' as RelayUrl;
    const conn = makeConn(() => ({
      promise: Promise.resolve<PublishOutcome>({ kind: 'ok' }),
      cancel: () => undefined
    }));
    const warnings: string[] = [];
    const b = new Broadcaster({
      pool: makePool(() => conn) as never,
      registry: makeRegistry([makeRelayRow(dest)]) as never,
      onLog: vi.fn(),
      onCounter: vi.fn(),
      onWarning: (m) => warnings.push(m)
    });

    const done = b.broadcastBatchToOne(dest, [makeEvent('e1'), makeEvent('e2')]);
    // Emit the NOTICE while the broadcast is in flight (before publishes
    // settle on this microtask).
    await Promise.resolve();
    conn.emitNotice('rate limit exceeded, slow down');
    conn.emitNotice('still rate limit exceeded'); // second hit shouldn't double-fire
    await done;

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/rate-limiting/);
    expect(warnings[0]).toMatch(/NOTICE/);
  });

  test('warns when destination returns transient OK with rate-limited reason', async () => {
    const dest = 'wss://throttled.example.com' as RelayUrl;
    const conn = makeConn(() => ({
      promise: Promise.resolve<PublishOutcome>({ kind: 'transient', reason: 'rate-limited: too fast' }),
      cancel: () => undefined
    }));
    const warnings: string[] = [];
    const b = new Broadcaster({
      pool: makePool(() => conn) as never,
      registry: makeRegistry([makeRelayRow(dest)]) as never,
      onLog: vi.fn(),
      onCounter: vi.fn(),
      onWarning: (m) => warnings.push(m)
    });
    await b.broadcastBatchToOne(dest, [makeEvent('e1'), makeEvent('e2'), makeEvent('e3')]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/rate-limited: too fast/);
  });

  test('does not warn on benign NOTICE or non-rate-limit transient', async () => {
    const dest = 'wss://chatty.example.com' as RelayUrl;
    const conn = makeConn(() => ({
      promise: Promise.resolve<PublishOutcome>({ kind: 'transient', reason: 'something else' }),
      cancel: () => undefined
    }));
    const warnings: string[] = [];
    const b = new Broadcaster({
      pool: makePool(() => conn) as never,
      registry: makeRegistry([makeRelayRow(dest)]) as never,
      onLog: vi.fn(),
      onCounter: vi.fn(),
      onWarning: (m) => warnings.push(m)
    });
    const done = b.broadcastBatchToOne(dest, [makeEvent('e1')]);
    await Promise.resolve();
    conn.emitNotice('relay maintenance window starts at midnight');
    await done;
    expect(warnings).toEqual([]);
  });

  test('caps in-flight publishes at singleTargetConcurrency for large batches', async () => {
    const dest = 'wss://dest.example.com' as RelayUrl;
    let dispatched = 0;
    let peak = 0;
    let inFlight = 0;
    const conn = makeConn(() => {
      dispatched++;
      inFlight++;
      if (inFlight > peak) peak = inFlight;
      // Auto-resolve on next microtask so workers cycle quickly.
      const promise = Promise.resolve<PublishOutcome>({ kind: 'ok' })
        .then(o => { inFlight--; return o; });
      return { promise, cancel: () => undefined };
    });
    const concurrency = 8;
    const b = new Broadcaster({
      pool: makePool(() => conn) as never,
      registry: makeRegistry([makeRelayRow(dest)]) as never,
      options: { singleTargetConcurrency: concurrency },
      onLog: vi.fn(),
      onCounter: vi.fn()
    });

    const events = Array.from({ length: 200 }, (_, i) => makeEvent(`e${i}`));
    await b.broadcastBatchToOne(dest, events);

    expect(dispatched).toBe(200);
    // Synchronous dispatch is bounded by the cap: even though all 200 events
    // are awaiting publishes, no more than `concurrency` are in flight at any
    // single moment.
    expect(peak).toBeLessThanOrEqual(concurrency);
  });

  test('returns BatchResult counts reflecting outcome mix', async () => {
    const dest = 'wss://dest.example.com' as RelayUrl;
    const outcomes: PublishOutcome[] = [
      { kind: 'ok' },
      { kind: 'ok' },
      { kind: 'duplicate' },
      { kind: 'transient', reason: 'flaky' },
      { kind: 'permanent', reason: 'invalid: bad sig' }
    ];
    let i = 0;
    const conn = makeConn(() => ({
      promise: Promise.resolve<PublishOutcome>(outcomes[i++]!),
      cancel: () => undefined
    }));
    const b = new Broadcaster({
      pool: makePool(() => conn) as never,
      registry: makeRegistry([makeRelayRow(dest)]) as never,
      onLog: vi.fn(),
      onCounter: vi.fn()
    });

    const result = await b.broadcastBatchToOne(
      dest,
      outcomes.map((_, k) => makeEvent(`e${k}`))
    );
    expect(result).toEqual({ ok: 2, duplicate: 1, transient: 1, permanent: 1, oversize: 0 });
  });

  test('counts NIP-11 oversize skips into BatchResult.oversize', async () => {
    const dest = 'wss://tight.example.com' as RelayUrl;
    const conn = makeConn(() => ({
      promise: Promise.resolve<PublishOutcome>({ kind: 'ok' }),
      cancel: () => undefined
    }));
    const b = new Broadcaster({
      pool: makePool(() => conn) as never,
      registry: makeRegistry([makeRelayRow(dest)], {
        cachedNip11: () => ({ limitation: { max_message_length: 32 } })
      }) as never,
      onLog: vi.fn(),
      onCounter: vi.fn()
    });
    const big = makeEvent('big', `{"id":"big","payload":"${'x'.repeat(200)}"}`);
    const result = await b.broadcastBatchToOne(dest, [big, big]);
    expect(result.oversize).toBe(2);
    expect(result.ok).toBe(0);
  });
});
