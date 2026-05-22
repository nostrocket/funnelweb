import { describe, test, expect, vi } from 'vitest';
import { Broadcaster } from '../../src/core/broadcaster';
import type { IngestedEvent, RelayUrl, RelayRow, PublishOutcome } from '../../src/types';

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

function makeEvent(id: string, pubkey: string, kind: number, created_at: number): IngestedEvent {
  return {
    id,
    parsed: { id, pubkey, kind, created_at, content: '', tags: [], sig: '' } as IngestedEvent['parsed'],
    raw: `{"id":"${id}"}`,
    receivedAt: Date.now()
  };
}

function makeRegistry(rows: RelayRow[]) {
  return {
    healthy: () => rows,
    all: () => rows,
    cachedNip11: () => null,
    nip11: async () => null,
    markSuccess: async () => undefined,
    markFailure: async () => undefined,
    markViable: async () => undefined,
    subscribe: () => () => undefined
  };
}

function makePool(conn: FakeConn) {
  return {
    get: () => conn,
    snapshot: () => [],
    isPinned: () => false,
    releaseIfNotPinned: () => true
  };
}

describe('Broadcaster ordering (per-relay FIFO)', () => {
  test('events arrive at a relay in batch order', async () => {
    const calls: string[] = [];
    const conn: FakeConn = {
      publish(_raw, id) {
        return {
          promise: new Promise<PublishOutcome>(resolve => {
            setTimeout(() => {
              calls.push(id);
              resolve({ kind: 'ok' });
            }, 0);
          }),
          cancel: () => undefined
        };
      }
    };
    const b = new Broadcaster({
      pool: makePool(conn) as never,
      registry: makeRegistry([makeRelayRow('wss://r.example.com')]) as never,
      onLog: vi.fn(),
      onCounter: vi.fn()
    });

    await b.broadcastBatch([
      makeEvent('id-3', 'pk-1', 0, 3),
      makeEvent('id-1', 'pk-1', 0, 1),
      makeEvent('id-2', 'pk-1', 0, 2)
    ]);

    expect(calls).toEqual(['id-3', 'id-1', 'id-2']);
  });

  test('per-relay queue is serial — slow events block subsequent ones to the same relay', async () => {
    // Per-relay drain is FIFO (matches the connect-publish-disconnect lifecycle).
    // The per-author chain that previously serialised replaceable kinds is no
    // longer needed; the FIFO queue gives the same guarantee.
    const order: string[] = [];
    const conn: FakeConn = {
      publish(_raw, id) {
        const delay = id.startsWith('A') ? 30 : 5;
        return {
          promise: new Promise<PublishOutcome>(resolve => {
            setTimeout(() => {
              order.push(id);
              resolve({ kind: 'ok' });
            }, delay);
          }),
          cancel: () => undefined
        };
      }
    };
    const b = new Broadcaster({
      pool: makePool(conn) as never,
      registry: makeRegistry([makeRelayRow('wss://r.example.com')]) as never,
      onLog: vi.fn(), onCounter: vi.fn()
    });

    await b.broadcastBatch([
      makeEvent('A1', 'pk-A', 0, 1),
      makeEvent('A2', 'pk-A', 0, 2),
      makeEvent('B1', 'pk-B', 0, 1)
    ]);

    expect(order).toEqual(['A1', 'A2', 'B1']);
  });

  test('different relays drain concurrently', async () => {
    // Each relay has its own worker, so a slow relay does not block a fast one.
    const r1Calls: string[] = [];
    const r2Calls: string[] = [];
    const conn1: FakeConn = {
      publish(_raw, id) {
        return {
          promise: new Promise<PublishOutcome>(resolve => setTimeout(() => {
            r1Calls.push(id);
            resolve({ kind: 'ok' });
          }, 30)),
          cancel: () => undefined
        };
      }
    };
    const conn2: FakeConn = {
      publish(_raw, id) {
        return {
          promise: new Promise<PublishOutcome>(resolve => setTimeout(() => {
            r2Calls.push(id);
            resolve({ kind: 'ok' });
          }, 1)),
          cancel: () => undefined
        };
      }
    };
    const rows = [makeRelayRow('wss://slow.example.com'), makeRelayRow('wss://fast.example.com')];
    const pool = {
      get: (url: RelayUrl) => url.includes('slow') ? conn1 : conn2,
      snapshot: () => [],
      isPinned: () => false,
      releaseIfNotPinned: () => true
    };
    const b = new Broadcaster({
      pool: pool as never,
      registry: makeRegistry(rows) as never,
      onLog: vi.fn(), onCounter: vi.fn()
    });

    await b.broadcastBatch([
      makeEvent('e1', 'pk', 1, 1),
      makeEvent('e2', 'pk', 1, 2)
    ]);

    // Fast relay finishes its FIFO drain (e1 then e2) well before the slow one.
    expect(r2Calls).toEqual(['e1', 'e2']);
    expect(r1Calls).toEqual(['e1', 'e2']);
  });
});
