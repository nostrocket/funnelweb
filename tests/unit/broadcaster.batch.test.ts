import { describe, test, expect, vi } from 'vitest';
import { Broadcaster } from '../../src/core/broadcaster';
import type { IngestedEvent, RelayUrl, RelayRow, PublishOutcome, Nip11Doc } from '../../src/types';

interface FakeConn {
  publish(raw: string, id: string): { promise: Promise<PublishOutcome>; cancel: () => void };
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

describe('Broadcaster.broadcastBatch', () => {
  test('resolves only after every per-relay queue has drained', async () => {
    const completed = { fast: false, slow: false };
    const fastConn: FakeConn = {
      publish: () => ({
        promise: new Promise<PublishOutcome>(resolve => setTimeout(() => {
          completed.fast = true;
          resolve({ kind: 'ok' });
        }, 5)),
        cancel: () => undefined
      })
    };
    const slowConn: FakeConn = {
      publish: () => ({
        promise: new Promise<PublishOutcome>(resolve => setTimeout(() => {
          completed.slow = true;
          resolve({ kind: 'ok' });
        }, 50)),
        cancel: () => undefined
      })
    };
    const rows = [makeRelayRow('wss://fast.example.com'), makeRelayRow('wss://slow.example.com')];
    const b = new Broadcaster({
      pool: makePool(url => url.includes('slow') ? slowConn : fastConn) as never,
      registry: makeRegistry(rows) as never,
      onLog: vi.fn(),
      onCounter: vi.fn()
    });

    await b.broadcastBatch([makeEvent('e1')]);
    expect(completed.fast).toBe(true);
    expect(completed.slow).toBe(true);
  });

  test('empty batch is a no-op', async () => {
    const conn: FakeConn = { publish: vi.fn(() => ({ promise: Promise.resolve<PublishOutcome>({ kind: 'ok' }), cancel: () => undefined })) };
    const b = new Broadcaster({
      pool: makePool(() => conn) as never,
      registry: makeRegistry([makeRelayRow('wss://r.example.com')]) as never,
      onLog: vi.fn(),
      onCounter: vi.fn()
    });
    await b.broadcastBatch([]);
    expect(conn.publish).not.toHaveBeenCalled();
  });

  test('honours per-relay NIP-11 max_message_length and logs permanent oversize', async () => {
    const conn: FakeConn = { publish: vi.fn(() => ({ promise: Promise.resolve<PublishOutcome>({ kind: 'ok' }), cancel: () => undefined })) };
    const url = 'wss://tight.example.com' as RelayUrl;
    const logged: { outcome: string; reason: string | null }[] = [];
    const b = new Broadcaster({
      pool: makePool(() => conn) as never,
      registry: makeRegistry([makeRelayRow(url)], {
        cachedNip11: () => ({ limitation: { max_message_length: 32 } })
      }) as never,
      onLog: (e) => logged.push({ outcome: e.outcome, reason: e.reason }),
      onCounter: vi.fn()
    });

    const big = makeEvent('big', `{"id":"big","payload":"${'x'.repeat(200)}"}`);
    await b.broadcastBatch([big]);

    expect(conn.publish).not.toHaveBeenCalled();
    expect(logged.some(e => e.outcome === 'permanent' && e.reason?.startsWith('oversize:'))).toBe(true);
  });

  test('demotes viability for auth/restricted/blocked permanent rejections', async () => {
    const calls: { url: string; viable: boolean; reason: string }[] = [];
    const conn: FakeConn = {
      publish: () => ({
        promise: Promise.resolve<PublishOutcome>({ kind: 'permanent', reason: 'auth-required: pubkey not allowed' }),
        cancel: () => undefined
      })
    };
    const url = 'wss://auth.example.com' as RelayUrl;
    const b = new Broadcaster({
      pool: makePool(() => conn) as never,
      registry: makeRegistry([makeRelayRow(url)], {
        onViable: (u, v, r) => calls.push({ url: u, viable: v, reason: r })
      }) as never,
      onLog: vi.fn(),
      onCounter: vi.fn()
    });

    await b.broadcastBatch([makeEvent('e1')]);
    expect(calls).toEqual([{ url, viable: false, reason: 'auth-required: pubkey not allowed' }]);
  });

  test('returns BatchResult summing outcomes across all relays', async () => {
    const okConn: FakeConn = { publish: () => ({ promise: Promise.resolve<PublishOutcome>({ kind: 'ok' }), cancel: () => undefined }) };
    const dupConn: FakeConn = { publish: () => ({ promise: Promise.resolve<PublishOutcome>({ kind: 'duplicate', reason: 'duplicate: known' }), cancel: () => undefined }) };
    const failConn: FakeConn = { publish: () => ({ promise: Promise.resolve<PublishOutcome>({ kind: 'transient', reason: 'broken' }), cancel: () => undefined }) };
    const rows = [
      makeRelayRow('wss://ok.example.com'),
      makeRelayRow('wss://dup.example.com'),
      makeRelayRow('wss://fail.example.com')
    ];
    const b = new Broadcaster({
      pool: makePool(url => {
        if (url.includes('ok.')) return okConn;
        if (url.includes('dup.')) return dupConn;
        return failConn;
      }) as never,
      registry: makeRegistry(rows) as never,
      onLog: vi.fn(),
      onCounter: vi.fn()
    });
    const result = await b.broadcastBatch([makeEvent('e1'), makeEvent('e2')]);
    // 2 events × 3 relays = 6 publishes: 2 ok, 2 duplicate, 2 transient.
    expect(result).toEqual({ ok: 2, duplicate: 2, transient: 2, permanent: 0, oversize: 0 });
  });

  test('does not demote viability for invalid/pow permanent rejections', async () => {
    const calls: unknown[] = [];
    const conn: FakeConn = {
      publish: () => ({
        promise: Promise.resolve<PublishOutcome>({ kind: 'permanent', reason: 'invalid: bad signature' }),
        cancel: () => undefined
      })
    };
    const url = 'wss://strict.example.com' as RelayUrl;
    const b = new Broadcaster({
      pool: makePool(() => conn) as never,
      registry: makeRegistry([makeRelayRow(url)], {
        onViable: (u, v, r) => calls.push({ u, v, r })
      }) as never,
      onLog: vi.fn(),
      onCounter: vi.fn()
    });

    await b.broadcastBatch([makeEvent('e1')]);
    expect(calls).toEqual([]);
  });
});
