import { attachConsole, info, warn, error } from './log';
import { DEFAULT_MONITOR_SEEDS, defaultSettings, type Phase, type Settings } from './types';
import { Store, createBus } from './store';
import { openDB, type DB } from './db/idb';
import { RelayPool } from './core/relayPool';
import { RelayRegistry } from './core/relayRegistry';
import { DedupeLru } from './core/dedupeLru';
import { SourceSubscriber } from './core/sourceSubscriber';
import { ReverseSubscriber } from './core/reverseSubscriber';
import { Discovery } from './core/discovery';
import { Prober } from './core/prober';
import { Broadcaster, type BroadcastEntry, type BroadcastCounters } from './core/broadcaster';
import { PreviewStore } from './core/previewStore';
import { normaliseRelayUrl } from './core/relayUrl';
import { validateFilterJson } from './core/filterValidator';
import { mountFilterPanel } from './ui/filterPanel';
import { mountPreviewPanel } from './ui/previewPanel';
import { mountBroadcastPanel } from './ui/broadcastPanel';
import { el } from './ui/components';

function byId(id: string): HTMLElement {
  const e = document.getElementById(id);
  if (!e) throw new Error(`missing element: ${id}`);
  return e;
}

function renderFatal(title: string, e: unknown): void {
  const main = document.getElementById('app') ?? document.body;
  while (main.firstChild) main.removeChild(main.firstChild);
  const banner = el('div', { class: 'fatal' }, [
    `${title}: ${(e as Error)?.message ?? String(e)}`
  ]);
  main.appendChild(banner);
}

async function main(): Promise<void> {
  const dbg = byId('debug-console');
  attachConsole(dbg);

  let db: DB;
  try { db = await openDB(); }
  catch (e) {
    error('main', 'IndexedDB unavailable', e);
    renderFatal('IndexedDB unavailable', e);
    return;
  }

  const persisted = await db.loadSettings().catch(() => null);
  // Merge against defaults so older persisted settings missing newer fields
  // (mode, destinationRelay) get sane values without a DB migration.
  const initial: Settings = { ...defaultSettings(), ...(persisted ?? {}) };
  if (initial.monitorSeeds.length === 0) {
    initial.monitorSeeds = [...DEFAULT_MONITOR_SEEDS];
  }
  // Always start in idle: phase is session-only. The user must explicitly
  // click "Start preview" → "Stop preview" → "Start broadcasting" each session.
  initial.phase = 'idle';
  const store = new Store<Settings>(initial);
  store.bindPersistence(s => db.saveSettings(s));

  const dedupe = new DedupeLru(initial.advanced.dedupeSize);
  const pool = new RelayPool({
    queueCapacity: initial.advanced.queueSizePerRelay,
    publishTimeoutMs: 8_000,
    maxFailures: 5,
    maxConnections: 256
  });
  const registry = new RelayRegistry(db, {
    nip11TtlMs: initial.advanced.nip11TtlMs,
    minHealthy: 3
  });
  await registry.load();

  const previewStore = new PreviewStore();
  const logBus = createBus<BroadcastEntry>();
  const counterBus = createBus<BroadcastCounters>();

  const broadcaster = new Broadcaster({
    pool, registry,
    onLog: e => logBus.emit(e),
    onCounter: c => counterBus.emit(c),
    onWarning: msg => warn('reverse', msg)
  });

  const source = new SourceSubscriber({
    pool, dedupe,
    onEvent: e => previewStore.add(e),
    onLive: () => info('source', 'EOSE; live'),
    onError: msg => warn('source', msg)
  });

  const reverse = new ReverseSubscriber({
    pool, registry, dedupe,
    onEvent: e => previewStore.add(e),
    onLive: () => info('reverse', 'queue drained; collection complete'),
    onError: msg => warn('reverse', msg)
  });

  const discovery = new Discovery(pool, registry, {
    sinceSecondsAgo: 86_400,
    perRelayLimit: 5_000
  });

  const prober = new Prober({ registry, pool });
  prober.start();

  // Wire UI
  mountFilterPanel(byId('panel-filter'), store, { db });
  mountPreviewPanel(byId('panel-preview'), {
    previewStore,
    store
  });
  mountBroadcastPanel(byId('panel-broadcast'), {
    broadcaster, registry, pool, prober, store, previewStore, db,
    onLog: (cb) => logBus.subscribe(cb),
    onCounter: (cb) => counterBus.subscribe(cb),
    onForgetAll: async () => {
      await registry.forgetAll();
    }
  });

  // Push an initial counter snapshot so the broadcast panel reflects any
  // already-persisted relays (and shows live updates as discovery upserts new
  // ones — the broadcaster subscribes to the registry).
  broadcaster.publishCounters();

  // Discovery and prober run continuously — they target NIP-66 monitor relays,
  // not the source relay, so they're unaffected by the user's phase. This
  // keeps the registry warm and ready for whenever broadcasting is triggered.
  discovery.setSeeds(initial.monitorSeeds);

  // React to settings changes. Phase transitions drive source.start/stop and
  // broadcaster.broadcastBatch; nothing else starts subsystems.
  store.subscribe(applySettings);

  function startCollecting(s: Settings): boolean {
    try {
      const { filter } = validateFilterJson(s.filterJson, s.advanced.maxFilterLimit);
      previewStore.setFilter(filter);
      if (s.mode === 'forward') {
        if (s.sourceRelay.trim() === '') {
          warn('source', 'no source relay configured');
          return false;
        }
        const url = normaliseRelayUrl(s.sourceRelay);
        source.start(url, filter);
      } else {
        reverse.start(filter);
      }
      return true;
    } catch (e) {
      warn('collect', String(e));
      return false;
    }
  }

  function applySettings(next: Settings, prev: Settings): void {
    // Mode flip is destructive: stop both subscribers and force idle. The
    // preview, source/destination fields, and phase are mode-specific so
    // continuing across a mode change would be incoherent.
    if (next.mode !== prev.mode) {
      source.stop();
      reverse.stop();
      if (next.phase !== 'idle') {
        queueMicrotask(() => store.set({ phase: 'idle' }));
      }
      return;
    }

    if (next.phase !== prev.phase) handlePhaseChange(prev.phase, next.phase, next);

    // Source/filter edits are only meaningful while collecting (live REQ open).
    // In ready, the preview is frozen; any edit forces a return to idle (set
    // by filterPanel/broadcastPanel itself). In broadcasting, edits are blocked
    // by the UI.
    if (next.phase === 'collecting') {
      const filterChanged = next.filterJson !== prev.filterJson;
      if (next.mode === 'forward') {
        const sourceChanged = next.sourceRelay !== prev.sourceRelay;
        if (sourceChanged || filterChanged) {
          try {
            const url = normaliseRelayUrl(next.sourceRelay);
            const { filter } = validateFilterJson(next.filterJson, next.advanced.maxFilterLimit);
            // previewStore.applyFilter is wired from previewPanel on filterJson changes.
            if (sourceChanged) source.start(url, filter);
            else source.reconfigure(filter);
          } catch (e) {
            warn('source', String(e));
            source.stop();
            store.set({ phase: 'idle' });
          }
        }
      } else if (filterChanged) {
        try {
          const { filter } = validateFilterJson(next.filterJson, next.advanced.maxFilterLimit);
          reverse.reconfigure(filter);
        } catch (e) {
          warn('reverse', String(e));
          reverse.stop();
          store.set({ phase: 'idle' });
        }
      }
    }

    if (next.monitorSeeds.join('\n') !== prev.monitorSeeds.join('\n')) {
      discovery.setSeeds(next.monitorSeeds);
    }
  }

  function handlePhaseChange(prev: Phase, next: Phase, settings: Settings): void {
    // idle → collecting: open the appropriate subscriber for the mode.
    if (next === 'collecting' && prev !== 'collecting') {
      if (!startCollecting(settings)) {
        queueMicrotask(() => store.set({ phase: 'idle' }));
      }
      return;
    }
    // collecting → ready: close subscription, retain preview.
    if (prev === 'collecting' && next === 'ready') {
      if (settings.mode === 'forward') source.stop();
      else reverse.stop();
      return;
    }
    // ready → broadcasting: subscription is already closed. Snapshot preview,
    // fan out (forward) or funnel (reverse), then return to idle. Preview is
    // cleared only on full success so the user can retry on partial failure
    // without re-collecting.
    if (next === 'broadcasting') {
      const events = previewStore.snapshot();
      info('main', `${settings.mode === 'forward' ? 'broadcasting' : 'funneling'} ${events.length} events`);
      const work = settings.mode === 'forward'
        ? broadcaster.broadcastBatch(events)
        : (() => {
            try {
              const dest = normaliseRelayUrl(settings.destinationRelay);
              return broadcaster.broadcastBatchToOne(dest, events);
            } catch (e) {
              warn('reverse', `bad destination: ${String(e)}`);
              return null;
            }
          })();
      if (work === null) {
        store.set({ phase: 'idle' });
        return;
      }
      void work.then(result => {
        const failed = result.transient + result.permanent + result.oversize;
        if (failed === 0) {
          previewStore.clear();
          info('main', `send drain complete: ${result.ok} ok, ${result.duplicate} duplicate`);
        } else {
          info('main', `send drain complete: ${result.ok} ok, ${result.duplicate} duplicate, ${failed} failed — preview retained for retry`);
        }
        store.set({ phase: 'idle' });
      }).catch(e => {
        error('main', 'send failed', e);
        store.set({ phase: 'idle' });
      });
      return;
    }
    // Anything → idle: ensure both subscribers are stopped.
    if (next === 'idle' && prev !== 'idle') {
      source.stop();
      reverse.stop();
      return;
    }
  }

  window.addEventListener('beforeunload', () => {
    prober.stop();
    discovery.stop();
    source.stop();
    reverse.stop();
    pool.destroy();
  });

  info('main', 'blaster ready');
}

main().catch(e => {
  console.error(e);
  renderFatal('startup failure', e);
});
