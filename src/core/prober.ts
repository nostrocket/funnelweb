import type { RelayUrl, RelayRow } from '../types';
import type { RelayRegistry } from './relayRegistry';
import type { RelayPool } from './relayPool';
import { debug } from '../log';

export interface ProberOptions {
  /** Probes in flight at once. */
  concurrency: number;
  /** Per-probe budget covering connect + first relay response (ms). */
  probeTimeoutMs: number;
}

export type WebSocketFactory = (url: string) => WebSocket;
const defaultFactory: WebSocketFactory = (url) => new WebSocket(url);

export interface ProberDeps {
  registry: RelayRegistry;
  pool: RelayPool;
  options?: Partial<ProberOptions>;
  /** Test injection for the WebSocket constructor used by probes. */
  wsFactory?: WebSocketFactory;
}

interface ProbeResult {
  viable: boolean;
  reason: string | null;
}

/**
 * Pre-flight relay viability classifier. Pre-filtering keeps the broadcaster's
 * fanout target set sane: NIP-66 monitors advertise thousands of relays and
 * most aren't writable from a browser (paid, auth-required, CORS-blocked at
 * the WS layer, plain unreachable). The broadcaster filters by `viable===true`,
 * so anything we don't probe never receives any forwarded events.
 *
 * The probe itself is intentionally cheap: an ephemeral WebSocket, one tiny
 * REQ, watch for the first relay-side message. Three signals classify a
 * relay as non-viable: AUTH challenge, CLOSED before EOSE/EVENT, or no message
 * within `probeTimeoutMs`. NIP-11 short-circuits the probe when the relay
 * advertises auth_required/payment_required.
 */
export class Prober {
  private readonly opts: ProberOptions;
  private readonly factory: WebSocketFactory;
  private inFlight = new Set<RelayUrl>();
  private pending: RelayUrl[] = [];
  private unsubRegistry: (() => void) | null = null;
  private stopped = false;

  constructor(private deps: ProberDeps) {
    this.opts = {
      concurrency: deps.options?.concurrency ?? 8,
      probeTimeoutMs: deps.options?.probeTimeoutMs ?? 6_000
    };
    this.factory = deps.wsFactory ?? defaultFactory;
  }

  start(): void {
    // Catch up on rows already loaded from IDB.
    this.enqueue(this.deps.registry.unprobed());
    // React to subsequent upserts.
    this.unsubRegistry = this.deps.registry.subscribe((rows) => {
      this.enqueue(rows.filter(r => r.viable === null));
    });
  }

  stop(): void {
    this.stopped = true;
    if (this.unsubRegistry) { this.unsubRegistry(); this.unsubRegistry = null; }
    this.pending.length = 0;
  }

  /** For tests / panel display. */
  inFlightCount(): number { return this.inFlight.size; }
  pendingCount(): number { return this.pending.length; }

  private enqueue(rows: RelayRow[]): void {
    if (this.stopped) return;
    for (const r of rows) {
      // Skip pinned URLs (source subscription, discovery seeds): probing opens
      // a second WS to a relay we are already actively reading from. Their
      // viability is implicitly proven by their use.
      if (this.deps.pool.isPinned(r.url)) {
        // Treat as viable so it stays in the broadcast target set.
        void this.deps.registry.markViable(r.url, true, 'pinned');
        continue;
      }
      if (this.inFlight.has(r.url)) continue;
      if (this.pending.includes(r.url)) continue;
      this.pending.push(r.url);
    }
    this.drain();
  }

  private drain(): void {
    while (!this.stopped && this.inFlight.size < this.opts.concurrency && this.pending.length > 0) {
      const url = this.pending.shift()!;
      this.inFlight.add(url);
      void this.runProbe(url).finally(() => {
        this.inFlight.delete(url);
        this.drain();
      });
    }
  }

  private async runProbe(url: RelayUrl): Promise<void> {
    // NIP-11 short-circuit. The registry caches the doc, so subsequent probes
    // for the same relay are free.
    try {
      const doc = await this.deps.registry.nip11(url);
      if (doc?.limitation?.auth_required) {
        await this.deps.registry.markViable(url, false, 'nip11:auth_required');
        return;
      }
      if (doc?.limitation?.payment_required) {
        await this.deps.registry.markViable(url, false, 'nip11:payment_required');
        return;
      }
    } catch (e) {
      debug('prober', `${url} nip11 lookup threw`, (e as Error).message);
    }

    const result = await this.wsProbe(url);
    await this.deps.registry.markViable(url, result.viable, result.reason);
  }

  private wsProbe(url: RelayUrl): Promise<ProbeResult> {
    return new Promise<ProbeResult>((resolve) => {
      let ws: WebSocket;
      try {
        ws = this.factory(url);
      } catch (e) {
        resolve({ viable: false, reason: `ws-ctor:${(e as Error).message}` });
        return;
      }
      const subId = 'probe-' + Math.random().toString(36).slice(2, 10);
      let settled = false;
      const finish = (r: ProbeResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          if (ws.readyState === WebSocket.OPEN) {
            try { ws.send(JSON.stringify(['CLOSE', subId])); } catch {}
          }
          ws.close();
        } catch {}
        resolve(r);
      };
      const timer = setTimeout(() => finish({ viable: false, reason: 'timeout' }),
        this.opts.probeTimeoutMs);

      ws.onopen = () => {
        try {
          ws.send(JSON.stringify(['REQ', subId, { kinds: [1], limit: 1 }]));
        } catch (e) {
          finish({ viable: false, reason: `req-send:${(e as Error).message}` });
        }
      };
      ws.onerror = () => {
        // The browser does not surface useful detail here; rely on onclose for
        // the reason but if open never fires we still want to settle.
        if (ws.readyState !== WebSocket.OPEN) {
          finish({ viable: false, reason: 'ws-error' });
        }
      };
      ws.onclose = (ev) => {
        finish({ viable: false, reason: `closed:${ev.code}` });
      };
      ws.onmessage = (ev) => {
        const data = typeof ev.data === 'string' ? ev.data : '';
        if (!data) return;
        let parsed: unknown;
        try { parsed = JSON.parse(data); } catch { return; }
        if (!Array.isArray(parsed) || typeof parsed[0] !== 'string') return;
        const tag = parsed[0];
        if (tag === 'AUTH') {
          finish({ viable: false, reason: 'auth-required' });
          return;
        }
        if (tag === 'EOSE' || tag === 'EVENT' || tag === 'NOTICE') {
          finish({ viable: true, reason: null });
          return;
        }
        if (tag === 'CLOSED') {
          const reason = String(parsed[2] ?? '');
          // Some relays CLOSE a probe REQ with an auth-required reason.
          finish({ viable: false, reason: `closed-sub:${reason}` });
          return;
        }
      };
    });
  }
}
