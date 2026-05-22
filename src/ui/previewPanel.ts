import { nip19 } from 'nostr-tools';
import type { IngestedEvent, Settings } from '../types';
import type { Store } from '../store';
import type { PreviewStore } from '../core/previewStore';
import { el, clearChildren } from './components';
import { validateFilterJson } from '../core/filterValidator';

export interface PreviewPanelDeps {
  previewStore: PreviewStore;
  store: Store<Settings>;
}

const PAGE_SIZE = 100;

export function mountPreviewPanel(root: HTMLElement, deps: PreviewPanelDeps): void {
  clearChildren(root);
  root.appendChild(el('h2', {}, ['Preview']));

  const counters = el('div', { class: 'counters' });
  const matchedEl = el('span', {}, ['matched: ']);
  const matchedN  = el('strong', {}, ['0']);
  const uniqueEl  = el('span', {}, [' · unique: ']);
  const uniqueN   = el('strong', {}, ['0']);
  // Only meaningful in reverse mode (forward has a single source relay).
  const fromEl    = el('span', {}, [' · from: ']);
  const fromN     = el('strong', {}, ['0']);
  const fromSuffix = el('span', {}, [' relays']);
  const phaseEl   = el('span', {}, [' · phase: ']);
  const phaseN    = el('strong', {}, [deps.store.get().phase]);
  matchedEl.append(matchedN);
  uniqueEl.append(uniqueN);
  fromEl.append(fromN, fromSuffix);
  phaseEl.append(phaseN);
  counters.append(matchedEl, uniqueEl, fromEl, phaseEl);
  fromEl.hidden = deps.store.get().mode !== 'reverse';
  root.appendChild(counters);

  const list = el('div', { class: 'event-list' });
  root.appendChild(list);

  const sentinel = el('div', { class: 'load-more-sentinel' });
  let renderLimit = PAGE_SIZE;
  let renderTimer: ReturnType<typeof setTimeout> | null = null;
  // Stable DOM nodes per event id. Rebuilding rows on every arrival
  // destroys the <details> the user just clicked, so we keep nodes
  // alive and only insert/move/remove as the visible set changes.
  const rowById = new Map<string, HTMLElement>();

  // IntersectionObserver may be unavailable in some non-browser test contexts;
  // guard so the panel still renders (just without auto-loading).
  const observer = typeof IntersectionObserver !== 'undefined'
    ? new IntersectionObserver(entries => {
        for (const e of entries) {
          if (e.isIntersecting) {
            renderLimit += PAGE_SIZE;
            doRender();
          }
        }
      }, { rootMargin: '400px' })
    : null;
  if (observer) observer.observe(sentinel);

  function relativeTime(seconds: number): string {
    const ms = Date.now() - seconds * 1_000;
    if (ms < 60_000) return `${Math.round(ms/1000)}s`;
    if (ms < 3_600_000) return `${Math.round(ms/60_000)}m`;
    if (ms < 86_400_000) return `${Math.round(ms/3_600_000)}h`;
    return `${Math.round(ms/86_400_000)}d`;
  }

  function escapeHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function highlightJson(text: string): string {
    return escapeHtml(text).replace(
      /("(?:\\u[a-fA-F0-9]{4}|\\[^u]|[^\\"])*"\s*:?)|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g,
      (match) => {
        let cls = 'jn-num';
        if (match.startsWith('"')) cls = /:\s*$/.test(match) ? 'jn-key' : 'jn-str';
        else if (match === 'true' || match === 'false') cls = 'jn-bool';
        else if (match === 'null') cls = 'jn-null';
        return `<span class="${cls}">${match}</span>`;
      }
    );
  }

  function renderRawWire(raw: string): HTMLElement {
    const pre = el('pre', { class: 'json-highlight' });
    try {
      pre.innerHTML = highlightJson(JSON.stringify(JSON.parse(raw), null, 2));
    } catch {
      pre.textContent = raw;
    }
    return pre;
  }

  function rowFor(e: IngestedEvent): HTMLElement {
    const row = el('div', { class: 'event-row' });
    const npub = nip19.npubEncode(e.parsed.pubkey).slice(0, 12);
    const meta = el('div', { class: 'meta' }, [
      `kind:${e.parsed.kind} · ${npub}… · ${relativeTime(e.parsed.created_at)} ago`
    ]);
    const content = el('div', { class: 'content' });
    const text = e.parsed.content || '';
    content.textContent = text.length > 160 ? text.slice(0, 160) + '…' : text;

    const det = el('details', {}) as HTMLDetailsElement;
    det.appendChild(el('summary', {}, ['raw wire']));
    det.appendChild(renderRawWire(e.raw));

    row.append(meta, content, det);
    return row;
  }

  function doRender() {
    const events = deps.previewStore.snapshot();
    events.sort((a, b) => b.parsed.created_at - a.parsed.created_at);
    const visible = events.slice(0, renderLimit);
    const visibleIds = new Set<string>();
    for (const e of visible) visibleIds.add(e.parsed.id);

    // Drop rows for events that fell out of the visible window
    // (filter change, applyFilter prune, etc.).
    for (const [id, row] of rowById) {
      if (!visibleIds.has(id)) {
        row.remove();
        rowById.delete(id);
      }
    }

    // Walk the desired order, creating rows as needed and moving
    // existing ones into position. insertBefore on an already-attached
    // node moves it without re-creating, so open <details> stay open.
    let cursor: ChildNode | null = list.firstChild;
    for (const e of visible) {
      let row = rowById.get(e.parsed.id);
      if (!row) {
        row = rowFor(e);
        rowById.set(e.parsed.id, row);
        list.insertBefore(row, cursor);
      } else if (row !== cursor) {
        list.insertBefore(row, cursor);
      } else {
        cursor = cursor.nextSibling;
        continue;
      }
      cursor = row.nextSibling;
    }

    if (events.length > visible.length) {
      if (sentinel.parentNode !== list || list.lastChild !== sentinel) {
        list.appendChild(sentinel);
      }
    } else if (sentinel.parentNode === list) {
      sentinel.remove();
    }

    matchedN.textContent = String(deps.previewStore.matchedCount());
    uniqueN.textContent  = String(deps.previewStore.uniqueCount());
    fromN.textContent    = String(deps.previewStore.contributorCount());
  }

  // Throttle: bursts of arrivals coalesce into one re-sort + re-render.
  function rerender() {
    if (renderTimer) return;
    renderTimer = setTimeout(() => {
      renderTimer = null;
      doRender();
    }, 100);
  }

  doRender();
  deps.previewStore.subscribe(rerender);

  deps.store.subscribe((next, prev) => {
    if (next.phase !== prev.phase) phaseN.textContent = next.phase;
    if (next.mode !== prev.mode) fromEl.hidden = next.mode !== 'reverse';
    if (next.filterJson === prev.filterJson) return;
    let filter;
    try {
      filter = validateFilterJson(next.filterJson, next.advanced.maxFilterLimit).filter;
    } catch {
      return;
    }
    renderLimit = PAGE_SIZE;
    deps.previewStore.applyFilter(filter);
  });
}
