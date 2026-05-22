import { describe, test, expect, vi } from 'vitest';
import { RelayConn, classifyOk } from '../../src/core/relayConn';
import type { RelayUrl } from '../../src/types';

class FakeWS {
  static OPEN = 1;
  static CLOSED = 3;
  readyState = 0;
  onopen: ((e?: unknown) => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: ((e?: unknown) => void) | null = null;
  onclose: ((e: { code: number; reason: string }) => void) | null = null;
  sent: string[] = [];

  constructor(public url: string) {}

  send(data: string): void { this.sent.push(data); }
  close(): void {
    this.readyState = FakeWS.CLOSED;
    this.onclose?.({ code: 1000, reason: 'normal' });
  }

  // Test helpers
  open(): void {
    this.readyState = FakeWS.OPEN;
    this.onopen?.();
  }
  emit(data: string): void {
    this.onmessage?.({ data });
  }
}

// Stub the global so RelayConn.OPEN comparison works.
(globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeWS;

describe('RelayConn OK matching (R7)', () => {
  test('two publishes resolve in OK arrival order, not send order', async () => {
    const ws = new FakeWS('wss://test.example.com');
    const conn = new RelayConn(
      'wss://test.example.com' as RelayUrl,
      { queueCapacity: 10, publishTimeoutMs: 5_000, maxFailures: 3 },
      () => ws
    );
    conn.open();
    ws.open();

    const idA = 'a'.repeat(64);
    const idB = 'b'.repeat(64);
    const evA = `{"id":"${idA}"}`;
    const evB = `{"id":"${idB}"}`;
    const handleA = conn.publish(evA, idA);
    const handleB = conn.publish(evB, idB);

    expect(ws.sent.length).toBeGreaterThanOrEqual(2);
    expect(ws.sent[0]).toBe(`["EVENT",${evA}]`);
    expect(ws.sent[1]).toBe(`["EVENT",${evB}]`);

    // OK arrives for B first, then A.
    ws.emit(JSON.stringify(['OK', idB, true, '']));
    ws.emit(JSON.stringify(['OK', idA, true, '']));

    const [oA, oB] = await Promise.all([handleA.promise, handleB.promise]);
    expect(oA.kind).toBe('ok');
    expect(oB.kind).toBe('ok');
  });

  test('queues publishes while connecting and flushes on open', async () => {
    const ws = new FakeWS('wss://test2.example.com');
    const conn = new RelayConn(
      'wss://test2.example.com' as RelayUrl,
      { queueCapacity: 10, publishTimeoutMs: 5_000, maxFailures: 3 },
      () => ws
    );
    // Trigger publish before opening.
    const id = 'c'.repeat(64);
    const ev = `{"id":"${id}"}`;
    const handle = conn.publish(ev, id);
    expect(ws.sent.length).toBe(0);

    ws.open();
    expect(ws.sent[0]).toBe(`["EVENT",${ev}]`);
    ws.emit(JSON.stringify(['OK', id, true, '']));
    const o = await handle.promise;
    expect(o.kind).toBe('ok');
  });
});

describe('classifyOk (R6)', () => {
  test('accepted ok', () => {
    expect(classifyOk(true, '')).toEqual({ kind: 'ok' });
  });
  test('accepted with duplicate prefix is duplicate', () => {
    expect(classifyOk(true, 'duplicate: already have')).toEqual({ kind: 'duplicate' });
  });
  test('rejected duplicate is duplicate', () => {
    expect(classifyOk(false, 'duplicate: x')).toEqual({ kind: 'duplicate' });
  });
  test('rejected blocked is permanent', () => {
    expect(classifyOk(false, 'blocked: spam')).toEqual({ kind: 'permanent', reason: 'blocked: spam' });
  });
  test('rejected unknown reason is transient', () => {
    expect(classifyOk(false, 'rate-limited')).toEqual({ kind: 'transient', reason: 'rate-limited' });
  });
});
