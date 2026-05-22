import type { Phase, Settings } from '../types';
import type { Store } from '../store';
import type { Broadcaster, BroadcastCounters, BroadcastEntry } from '../core/broadcaster';
import type { RelayRegistry } from '../core/relayRegistry';
import type { RelayPool } from '../core/relayPool';
import type { PreviewStore } from '../core/previewStore';
import type { Prober } from '../core/prober';
import type { Mode } from '../types';
import type { DB } from '../db/idb';
import { el, createButton, createTextInput, clearChildren, showConfirmModal } from './components';
import { validateFilterJson, FilterValidationError } from '../core/filterValidator';
import { tryNormaliseRelayUrl } from '../core/relayUrl';

export interface BroadcastPanelDeps {
  broadcaster: Broadcaster;
  registry: RelayRegistry;
  pool: RelayPool;
  prober: Prober;
  store: Store<Settings>;
  previewStore: PreviewStore;
  db: DB;
  onLog: (cb: (entry: BroadcastEntry) => void) => () => void;
  onCounter: (cb: (c: BroadcastCounters) => void) => () => void;
  onForgetAll: () => Promise<void>;
}

export function mountBroadcastPanel(root: HTMLElement, deps: BroadcastPanelDeps): void {
  clearChildren(root);
  const heading = el('h2', {}, ['Broadcast']);
  root.appendChild(heading);

  // Mode + relay endpoint. Sit at the top of the broadcast panel since they
  // determine *where* the broadcast goes. The relay-input label and value
  // swap between source/destination based on mode.
  const s0 = deps.store.get();

  const modeLabel = el('div', { class: 'mode-label' }, ['Mode']);
  const fwdBtn = el('button', { type: 'button', class: 'seg-btn' }, ['Broadcast (1 → many)']) as HTMLButtonElement;
  const revBtn = el('button', { type: 'button', class: 'seg-btn' }, ['Funnel (many → 1)']) as HTMLButtonElement;
  const modeRow = el('div', { class: 'segmented' }, [fwdBtn, revBtn]);
  const setMode = (next: Mode) => {
    if (next !== deps.store.get().mode) deps.store.set({ mode: next });
  };
  fwdBtn.addEventListener('click', () => setMode('forward'));
  revBtn.addEventListener('click', () => setMode('reverse'));
  function syncModeRadio(): void {
    const m = deps.store.get().mode;
    fwdBtn.classList.toggle('active', m === 'forward');
    revBtn.classList.toggle('active', m === 'reverse');
    fwdBtn.setAttribute('aria-pressed', m === 'forward' ? 'true' : 'false');
    revBtn.setAttribute('aria-pressed', m === 'reverse' ? 'true' : 'false');
  }
  syncModeRadio();
  root.append(modeLabel, modeRow);

  const relayLabelEl = el('label', {});
  const relayListId = 'relay-history-list';
  const relayList = el('datalist', { id: relayListId }) as HTMLDataListElement;
  const relayInput = createTextInput(
    { type: 'url', placeholder: 'wss://relay.example.com' },
    (v) => {
      const isReverseNow = deps.store.get().mode === 'reverse';
      if (isReverseNow) deps.store.set({ destinationRelay: v });
      else deps.store.set({ sourceRelay: v });
      const norm = tryNormaliseRelayUrl(v);
      relayErr.textContent = v && !norm ? 'must be a valid wss:// or ws:// URL' : '';
      if (norm) {
        void deps.db.rememberHistory('relay', norm)
          .then(() => refreshRelayHistory())
          .catch(() => { /* best-effort */ });
      }
    }
  );
  relayInput.setAttribute('list', relayListId);
  const relayErr = el('div', { class: 'error' });

  async function refreshRelayHistory(): Promise<void> {
    try {
      const rows = await deps.db.loadHistory('relay');
      clearChildren(relayList);
      for (const r of rows) {
        relayList.appendChild(el('option', { value: r.value }));
      }
    } catch { /* best-effort */ }
  }
  void refreshRelayHistory();
  function syncRelayInput(): void {
    const cur = deps.store.get();
    const isReverseNow = cur.mode === 'reverse';
    relayLabelEl.textContent = isReverseNow
      ? 'Destination relay (wss://...) — events funnel here'
      : 'Source relay (wss://...) — subscribe here';
    const target = isReverseNow ? cur.destinationRelay : cur.sourceRelay;
    if (relayInput.value !== target) relayInput.value = target;
  }
  syncRelayInput();
  root.append(relayLabelEl, relayInput, relayList, relayErr);

  // Per-URL log stats (ok/fail/last reason). Declared early because both the
  // destination-status widget and the per-relay table read from it.
  const stats = new Map<string, { ok: number; fail: number; lastReason: string | null }>();
  function statsFor(url: string) {
    let s = stats.get(url);
    if (!s) { s = { ok: 0, fail: 0, lastReason: null }; stats.set(url, s); }
    return s;
  }

  // Destination relay status widget — only visible in reverse mode. Reuses
  // the same data sources that feed the per-relay table below: pool.snapshot()
  // for conn state + queue depth, and the per-URL stats map for ok/fail/
  // lastReason populated from onLog.
  // Declared up here (before reflect() and the buttons) so the first call to
  // reflect() can toggle destWrap.hidden without hitting the TDZ.
  const destWrap = el('div', { class: 'dest-status' });
  destWrap.hidden = true;
  const destTitle = el('div', { class: 'muted' }, ['Destination relay']);
  const destBody = el('div', { class: 'row' });
  const destDot = el('span', { class: 'dot' });
  destDot.style.display = 'inline-block';
  destDot.style.width = '10px';
  destDot.style.height = '10px';
  destDot.style.borderRadius = '50%';
  destDot.style.marginRight = '6px';
  destDot.style.background = '#888';
  const destUrl = el('span', { class: 'mono' }, ['(no destination configured)']);
  const destState = el('span', { class: 'muted' }, ['']);
  const destQueue = el('span', { class: 'muted' }, ['']);
  const destOk = el('span', { class: 'muted' }, ['']);
  const destFail = el('span', { class: 'muted' }, ['']);
  const destReason = el('span', { class: 'muted' }, ['']);
  destBody.append(destDot, destUrl, destState, destQueue, destOk, destFail, destReason);
  destWrap.append(destTitle, destBody);

  function colorForState(state: string): string {
    if (state === 'open') return '#3a7d3a';
    if (state === 'connecting' || state === 'closed') return '#c08a1a';
    if (state === 'dead') return '#a83232';
    return '#888';
  }

  function renderDestStatus(): void {
    const s = deps.store.get();
    if (s.mode !== 'reverse') return;
    const norm = tryNormaliseRelayUrl(s.destinationRelay);
    if (!norm) {
      destUrl.textContent = '(no destination configured)';
      destState.textContent = '';
      destQueue.textContent = '';
      destOk.textContent = '';
      destFail.textContent = '';
      destReason.textContent = '';
      destDot.style.background = '#888';
      return;
    }
    destUrl.textContent = norm;
    const snap = deps.pool.snapshot().find(p => p.url === norm);
    const state = snap?.stats.state ?? 'idle';
    const qDepth = snap?.stats.queueDepth ?? 0;
    const stat = stats.get(norm);
    destState.textContent = ` · state: ${state}`;
    destQueue.textContent = ` · queue: ${qDepth}`;
    destOk.textContent = ` · ok: ${stat?.ok ?? 0}`;
    destFail.textContent = ` · fail: ${stat?.fail ?? 0}`;
    destReason.textContent = stat?.lastReason ? ` · last: ${stat.lastReason}` : '';
    destDot.style.background = colorForState(state);
  }

  const buttonRow = el('div', { class: 'row' });
  const previewBtn = createButton('Start preview', () => {
    const phase = deps.store.get().phase;
    if (phase === 'idle' || phase === 'ready') {
      deps.store.set({ phase: 'collecting' });
    } else if (phase === 'collecting') {
      deps.store.set({ phase: 'ready' });
    }
  });

  const broadcastBtn = createButton('Start broadcasting', async () => {
    const s = deps.store.get();
    if (s.phase !== 'ready') return;
    const events = deps.previewStore.snapshot();
    if (events.length === 0) return;

    let summary: string;
    try {
      const { filter } = validateFilterJson(s.filterJson, s.advanced.maxFilterLimit);
      summary = JSON.stringify(filter, null, 2);
    } catch (e) {
      summary = `INVALID FILTER: ${(e as FilterValidationError).message}`;
    }
    const body = el('div', {});
    body.appendChild(el('div', { class: 'muted' }, [`Events to send: ${events.length}`]));
    if (s.mode === 'forward') {
      const healthyCount = deps.registry.healthy().length;
      body.appendChild(el('div', { class: 'muted' }, [`Healthy targets: ${healthyCount}`]));
    } else {
      const dest = tryNormaliseRelayUrl(s.destinationRelay);
      body.appendChild(el('div', { class: 'muted' }, [`Destination: ${dest ?? '(invalid)'}`]));
    }
    body.appendChild(el('div', { class: 'muted' }, ['Filter:']));
    const pre = el('pre', {});
    pre.textContent = summary;
    body.appendChild(pre);
    const ok = await showConfirmModal({
      title: s.mode === 'forward' ? 'Start broadcasting?' : 'Start funneling to destination?',
      body,
      confirmLabel: s.mode === 'forward' ? 'Start broadcasting' : 'Start funneling'
    });
    if (!ok) return;
    deps.store.set({ phase: 'broadcasting' });
  });

  function reflect(phase: Phase): void {
    const s = deps.store.get();
    const eventCount = deps.previewStore.size();
    heading.textContent = s.mode === 'forward' ? 'Broadcast' : 'Broadcast (reverse — funnel to destination)';

    // Preview button
    if (phase === 'idle') {
      previewBtn.textContent = 'Start preview';
      previewBtn.disabled = false;
      previewBtn.classList.remove('armed');
    } else if (phase === 'collecting') {
      previewBtn.textContent = 'Stop preview';
      previewBtn.disabled = false;
      previewBtn.classList.add('armed');
    } else if (phase === 'ready') {
      previewBtn.textContent = 'Resume preview';
      previewBtn.disabled = false;
      previewBtn.classList.remove('armed');
    } else { // broadcasting
      previewBtn.textContent = 'Preview';
      previewBtn.disabled = true;
      previewBtn.classList.remove('armed');
    }

    // Broadcast button: only enabled in `ready` with events present, and in
    // reverse mode we additionally require a parseable destination relay.
    if (phase === 'broadcasting') {
      broadcastBtn.textContent = s.mode === 'forward' ? 'Broadcasting…' : 'Funneling…';
      broadcastBtn.disabled = true;
      broadcastBtn.classList.add('armed');
    } else {
      broadcastBtn.textContent = s.mode === 'forward' ? 'Start broadcasting' : 'Start funneling to destination';
      const baseReady = phase === 'ready' && eventCount > 0;
      const destOk = s.mode === 'forward' || tryNormaliseRelayUrl(s.destinationRelay) !== null;
      broadcastBtn.disabled = !(baseReady && destOk);
      broadcastBtn.classList.remove('armed');
    }

    // Show/hide the destination status widget by mode.
    destWrap.hidden = s.mode !== 'reverse';
  }

  reflect(deps.store.get().phase);
  deps.store.subscribe((next, prev) => {
    if (
      next.phase !== prev.phase ||
      next.mode !== prev.mode ||
      next.destinationRelay !== prev.destinationRelay ||
      next.sourceRelay !== prev.sourceRelay
    ) {
      reflect(next.phase);
      if (next.mode !== prev.mode) syncModeRadio();
      if (next.mode !== prev.mode || next.destinationRelay !== prev.destinationRelay) {
        renderDestStatus();
      }
      if (
        next.mode !== prev.mode ||
        next.sourceRelay !== prev.sourceRelay ||
        next.destinationRelay !== prev.destinationRelay
      ) {
        syncRelayInput();
      }
    }
  });
  // Re-evaluate broadcast button as the preview accumulates events.
  deps.previewStore.subscribe(() => reflect(deps.store.get().phase));

  buttonRow.append(previewBtn, broadcastBtn);
  root.appendChild(buttonRow);

  // Counters are grouped by lifecycle stage so the labels disambiguate where
  // each number comes from:
  //   registry  — discovered / healthy / dead       (size of the candidate set)
  //   prober    — probing / to probe                (gating viable=true)
  //   broadcast — events sent / relays reached / dropped
  // "Relays reached" is distinct relays where ≥1 event was accepted
  // (BroadcastCounters.delivered). "Events sent" is the sum of OKs across
  // every relay — the actual fanout volume.
  const counters = el('div', { class: 'counters' });
  const mk = (label: string) => {
    const wrap = el('span', {}, [`${label}: `]);
    const n = el('strong', {}, ['0']);
    wrap.append(n);
    return { wrap, n };
  };
  const cDiscovered = mk('discovered');
  const cHealthy    = mk('healthy');
  const cDead       = mk('dead');
  const cProbing    = mk('probing');
  const cToProbe    = mk('to probe');
  const cEventsSent = mk('events sent');
  const cReached    = mk('relays reached');
  const cDropped    = mk('dropped');
  counters.append(
    cDiscovered.wrap, cHealthy.wrap, cDead.wrap,
    cProbing.wrap, cToProbe.wrap,
    cEventsSent.wrap, cReached.wrap, cDropped.wrap
  );
  root.appendChild(counters);

  // Append the destination-status widget (constructed at the top of this
  // function). DOM order: heading → buttons → counters → destWrap → table.
  root.appendChild(destWrap);

  // Per-relay table
  const tableWrap = el('div', { class: 'table-wrap' });
  root.appendChild(tableWrap);

  // Forget all relays — wipes the discovered relay table and NIP-11 cache.
  const forgetBtn = createButton('Forget all relays', async () => {
    const confirmed = await showConfirmModal({
      title: 'Forget all relays?',
      body: 'This wipes the discovered relay table and NIP-11 cache. Source relay & filter remain.',
      confirmLabel: 'Forget all',
      danger: true
    });
    if (!confirmed) return;
    await deps.onForgetAll();
  }, { variant: 'danger' });
  root.appendChild(el('div', { class: 'row' }, [forgetBtn]));

  function renderTable() {
    clearChildren(tableWrap);
    const table = el('table', {});
    const thead = el('thead', {}, []);
    const trh = el('tr', {});
    for (const h of ['relay', 'ok', 'fail', 'queue', 'last reason']) {
      trh.appendChild(el('th', {}, [h]));
    }
    thead.appendChild(trh);
    table.appendChild(thead);

    const tbody = el('tbody', {});
    const snap = deps.pool.snapshot();
    const byUrl = new Map(snap.map(s => [s.url, s]));
    const all = deps.registry.all();
    const rows = all.slice().sort((a, b) => b.lastSeen - a.lastSeen);
    for (const r of rows) {
      const tr = el('tr', {});
      const conn = byUrl.get(r.url);
      const s = statsFor(r.url);
      tr.appendChild(el('td', {}, [r.url + (r.dead ? ' (dead)' : '')]));
      tr.appendChild(el('td', {}, [String(s.ok)]));
      tr.appendChild(el('td', {}, [String(s.fail)]));
      tr.appendChild(el('td', {}, [conn ? String(conn.stats.queueDepth) : '-']));
      tr.appendChild(el('td', {}, [s.lastReason ?? '']));
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    tableWrap.appendChild(table);
  }

  let eventsSent = 0;

  deps.onCounter(c => {
    cDiscovered.n.textContent = String(c.discovered);
    cHealthy.n.textContent    = String(c.healthy);
    cDead.n.textContent       = String(c.dead);
    cDropped.n.textContent    = String(c.dropped);
    cReached.n.textContent    = String(c.delivered);
  });

  deps.onLog(entry => {
    const s = statsFor(entry.url);
    if (entry.outcome === 'ok' || entry.outcome === 'duplicate') {
      s.ok++;
      eventsSent++;
      cEventsSent.n.textContent = String(eventsSent);
    } else if (entry.outcome === 'transient' || entry.outcome === 'permanent') {
      s.fail++;
      s.lastReason = entry.reason;
    }
  });

  function refreshProbeCounters() {
    cProbing.n.textContent = String(deps.prober.inFlightCount());
    cToProbe.n.textContent = String(deps.prober.pendingCount());
  }

  deps.registry.subscribe(() => renderTable());
  renderTable();
  renderDestStatus();
  refreshProbeCounters();
  const tableTimer = setInterval(() => {
    renderTable();
    renderDestStatus();
    refreshProbeCounters();
  }, 1_000);
  window.addEventListener('beforeunload', () => clearInterval(tableTimer));
}
