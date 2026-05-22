import { nip19 } from 'nostr-tools';
import type { Settings, AdvancedSettings } from '../types';
import type { Store } from '../store';
import type { DB } from '../db/idb';
import {
  el, clearChildren, createButton, createNumberInput, createCollapsiblePanel, showInfoModal,
  createHistoryPicker
} from './components';
import { validateFilterJson, FilterValidationError } from '../core/filterValidator';
import { mountDateRangePicker, type DateRange } from './dateRangePicker';

export interface FilterPanelDeps {
  db: DB;
}

const SIMPLE_KEYS = new Set(['authors', 'ids', 'kinds', 'since', 'until', 'limit', '#e', '#p']);

interface SimpleForm {
  authors: string;
  eventId: string;
  replyTo: string;
  mentions: string;
  kinds: string;
  sinceUnix: number | null;
  untilUnix: number | null;
  limit: string;
}

export function mountFilterPanel(
  root: HTMLElement,
  store: Store<Settings>,
  deps: FilterPanelDeps
): void {
  clearChildren(root);
  const { details, content: body } = createCollapsiblePanel('Filter', 'blaster-panel-filter-open');
  root.appendChild(details);

  // Mode toggle
  let mode: 'simple' | 'json' = isSimpleCompatible(store.get().filterJson) ? 'simple' : 'json';

  const modeRow = el('div', { class: 'row mode-toggle' });
  const simpleRadio = el('input', { type: 'radio', name: 'filter-mode' }) as HTMLInputElement;
  const jsonRadio = el('input', { type: 'radio', name: 'filter-mode' }) as HTMLInputElement;
  simpleRadio.checked = mode === 'simple';
  jsonRadio.checked = mode === 'json';
  modeRow.append(
    el('label', { class: 'inline' }, [simpleRadio, ' Simple']),
    el('label', { class: 'inline' }, [jsonRadio, ' JSON'])
  );
  body.appendChild(modeRow);

  // Simple section
  const simpleSection = el('div', { class: 'simple-form' });
  const authorsTa = el('textarea', { placeholder: 'one per line — hex64 or npub1…' }) as HTMLTextAreaElement;
  authorsTa.style.minHeight = '64px';
  const eventIdIn = el('input', { type: 'text', placeholder: 'hex64, note1…, or nevent1…' }) as HTMLInputElement;
  const replyToIn = el('input', { type: 'text', placeholder: 'hex64, note1…, or nevent1…' }) as HTMLInputElement;
  const mentionsTa = el('textarea', { placeholder: 'one per line — hex64 or npub1…' }) as HTMLTextAreaElement;
  mentionsTa.style.minHeight = '64px';
  const kindsIn = el('input', { type: 'text', placeholder: '1, 6, 7' }) as HTMLInputElement;
  const limitIn = el('input', { type: 'number', min: '1', placeholder: '200' }) as HTMLInputElement;

  function appendLine(ta: HTMLTextAreaElement, value: string): void {
    const current = ta.value;
    const lines = current.split('\n').map(s => s.trim());
    if (lines.includes(value.trim())) return;
    const sep = current === '' || current.endsWith('\n') ? '' : '\n';
    ta.value = `${current}${sep}${value}\n`;
    ta.focus();
  }

  const authorsPicker = createHistoryPicker('Add from history…', (v) => appendLine(authorsTa, v));
  const mentionsPicker = createHistoryPicker('Add from history…', (v) => appendLine(mentionsTa, v));

  async function refreshPubkeyHistory(): Promise<void> {
    try {
      const rows = await deps.db.loadHistory('pubkey');
      const values = rows.map(r => r.value);
      authorsPicker.setOptions(values);
      mentionsPicker.setOptions(values);
    } catch { /* history is best-effort */ }
  }
  void refreshPubkeyHistory();

  const dateRangeContainer = el('div');
  let currentRange: DateRange = { sinceUnix: null, untilUnix: null };
  const picker = mountDateRangePicker(dateRangeContainer, {
    onChange: (r) => { currentRange = r; updateDateSummary(); }
  });

  const dateSummary = el('span', { class: 'date-summary muted' }, ['Any time']);
  const dateBtn = createButton('Pick dates…', () => {
    showInfoModal({ title: 'Date range', body: dateRangeContainer });
  });
  const dateRow = el('div', { class: 'row date-row' }, [dateSummary, dateBtn]);

  function fmtUnix(unix: number): string {
    const d = new Date(unix * 1000);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }
  function updateDateSummary(): void {
    if (currentRange.sinceUnix === null && currentRange.untilUnix === null) {
      dateSummary.textContent = 'Any time';
      return;
    }
    const s = currentRange.sinceUnix !== null ? fmtUnix(currentRange.sinceUnix) : '—';
    const e = currentRange.untilUnix !== null ? fmtUnix(currentRange.untilUnix) : '—';
    dateSummary.textContent = `${s} → ${e}`;
  }

  simpleSection.append(
    el('label', {}, ['Authors (hex or npub, one per line)', authorsTa, authorsPicker.el]),
    el('label', {}, ['Event ID (subscribe to a specific event)', eventIdIn]),
    el('label', {}, ['Replies to event ID (#e tag)', replyToIn]),
    el('label', {}, ['Mentions pubkey (#p tag, one per line)', mentionsTa, mentionsPicker.el]),
    el('label', {}, ['Kinds (comma-separated)', kindsIn]),
    el('label', {}, ['Date range', dateRow]),
    el('label', {}, ['Limit', limitIn])
  );

  // JSON section
  const jsonSection = el('div', { class: 'json-form' });
  jsonSection.appendChild(el('div', { class: 'muted' }, [
    'JSON object — must include at least one of authors/kinds/since/until and a "limit".'
  ]));
  const ta = el('textarea', { placeholder: '{ "kinds":[1], "limit":200 }' }) as HTMLTextAreaElement;
  ta.style.minHeight = '180px';
  ta.style.fontFamily = 'inherit';
  jsonSection.appendChild(ta);

  const errEl = el('div', { class: 'error' });
  const warnEl = el('div', { class: 'warn' });
  const okEl = el('div', { class: 'muted' });

  const actionsRow = el('div', { class: 'row actions' });
  const updateBtn = createButton('Update filter', () => onUpdateClicked());
  const clearBtn = createButton('Clear', () => onClearClicked());
  actionsRow.append(updateBtn, clearBtn);

  body.append(simpleSection, jsonSection, actionsRow, errEl, warnEl, okEl);

  // Advanced link — opens a modal with the advanced settings.
  const advLink = el('a', { href: '#', class: 'advanced-link' }, ['Advanced…']);
  advLink.addEventListener('click', (e) => {
    e.preventDefault();
    showInfoModal({ title: 'Advanced settings', body: buildAdvancedForm(store) });
  });
  body.appendChild(el('div', { class: 'row advanced-row' }, [advLink]));

  function fillSimple(): string[] {
    const { form, dropped } = parseSimpleFromJson(store.get().filterJson);
    authorsTa.value = form.authors;
    eventIdIn.value = form.eventId;
    replyToIn.value = form.replyTo;
    mentionsTa.value = form.mentions;
    kindsIn.value = form.kinds;
    limitIn.value = form.limit;
    currentRange = { sinceUnix: form.sinceUnix, untilUnix: form.untilUnix };
    picker.setRange(currentRange);
    updateDateSummary();
    return dropped;
  }
  function fillJson(): void {
    ta.value = store.get().filterJson;
  }

  function showMode(): void {
    simpleSection.hidden = mode !== 'simple';
    jsonSection.hidden = mode !== 'json';
    errEl.textContent = '';
    warnEl.textContent = '';
    okEl.textContent = '';
    if (mode === 'simple') {
      const dropped = fillSimple();
      if (dropped.length > 0) {
        warnEl.textContent =
          `Simple mode does not represent: ${dropped.join(', ')} — these will be dropped on next edit.`;
      }
    } else {
      fillJson();
    }
  }
  showMode();

  simpleRadio.addEventListener('change', () => {
    if (!simpleRadio.checked) return;
    mode = 'simple';
    showMode();
  });
  jsonRadio.addEventListener('change', () => {
    if (!jsonRadio.checked) return;
    mode = 'json';
    showMode();
  });

  function clearMessages(): void {
    errEl.textContent = '';
    warnEl.textContent = '';
    okEl.textContent = '';
  }

  async function onUpdateClicked(): Promise<void> {
    clearMessages();
    const max = store.get().advanced.maxFilterLimit;
    let json: string;
    if (mode === 'simple') {
      try {
        json = buildJsonFromForm({
          authors: authorsTa.value,
          eventId: eventIdIn.value,
          replyTo: replyToIn.value,
          mentions: mentionsTa.value,
          kinds: kindsIn.value,
          sinceUnix: currentRange.sinceUnix,
          untilUnix: currentRange.untilUnix,
          limit: limitIn.value
        });
      } catch (e) {
        errEl.textContent = (e as Error).message;
        return;
      }
    } else {
      json = ta.value;
    }
    let warnings: string[];
    try {
      ({ warnings } = validateFilterJson(json, max));
    } catch (e) {
      errEl.textContent = (e as Error).message;
      return;
    }
    if (warnings.length > 0) warnEl.textContent = warnings.join(' • ');
    if (mode === 'simple') {
      const lines = [
        ...authorsTa.value.split('\n'),
        ...mentionsTa.value.split('\n')
      ].map(s => s.trim()).filter(s => s.length > 0);
      const unique = Array.from(new Set(lines));
      void Promise.all(unique.map(v => deps.db.rememberHistory('pubkey', v)))
        .then(() => refreshPubkeyHistory())
        .catch(() => { /* best-effort */ });
    }
    if (json === store.get().filterJson) {
      okEl.textContent = 'No changes.';
      return;
    }
    // Await the IDB write before confirming success. Fire-and-forget left a
    // window where Safari/WebKit could abort the transaction before commit,
    // so a refresh saw the old value even after the user clicked Update.
    store.set({ filterJson: json, phase: 'idle' });
    updateBtn.disabled = true;
    okEl.textContent = 'Saving…';
    try {
      await store.flushPersist();
      okEl.textContent = 'Filter updated.';
    } catch (e) {
      errEl.textContent = `save failed: ${(e as Error).message}`;
      okEl.textContent = '';
    } finally {
      updateBtn.disabled = false;
    }
  }

  function onClearClicked(): void {
    clearMessages();
    if (mode === 'simple') {
      authorsTa.value = '';
      eventIdIn.value = '';
      replyToIn.value = '';
      mentionsTa.value = '';
      kindsIn.value = '';
      limitIn.value = '';
      currentRange = { sinceUnix: null, untilUnix: null };
      picker.setRange(currentRange);
      updateDateSummary();
    } else {
      ta.value = '';
    }
  }
}

function buildAdvancedForm(store: Store<Settings>): HTMLElement {
  const wrap = el('div', { class: 'advanced-form' });
  const advRow = (label: string, input: HTMLElement) => {
    const row = el('div', { class: 'row' });
    const lab = el('label', {}, [label]);
    lab.style.flex = '0 0 200px';
    row.append(lab, input);
    return row;
  };
  const setAdv = (patch: Partial<AdvancedSettings>) => {
    store.update(curr => ({ ...curr, advanced: { ...curr.advanced, ...patch } }));
  };
  const adv = store.get().advanced;
  wrap.appendChild(advRow('Max filter limit',
    createNumberInput(adv.maxFilterLimit, (n) => setAdv({ maxFilterLimit: n }))));
  wrap.appendChild(advRow('Dedupe LRU size',
    createNumberInput(adv.dedupeSize, (n) => setAdv({ dedupeSize: n }))));
  wrap.appendChild(advRow('Per-relay queue size',
    createNumberInput(adv.queueSizePerRelay, (n) => setAdv({ queueSizePerRelay: n }))));
  wrap.appendChild(advRow('NIP-11 TTL (ms)',
    createNumberInput(adv.nip11TtlMs, (n) => setAdv({ nip11TtlMs: n }))));
  const persistRow = el('div', { class: 'row' });
  const persistCb = el('input', { type: 'checkbox' }) as HTMLInputElement;
  persistCb.checked = adv.persistDedupe;
  persistCb.addEventListener('change', () => setAdv({ persistDedupe: persistCb.checked }));
  persistRow.append(el('label', {}, ['Persist dedupe to IDB']), persistCb);
  wrap.appendChild(persistRow);
  return wrap;
}

function isSimpleCompatible(json: string): boolean {
  try {
    const parsed = JSON.parse(json);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
    return Object.keys(parsed).every(k => SIMPLE_KEYS.has(k));
  } catch { return false; }
}

function parseSimpleFromJson(json: string): { form: SimpleForm; dropped: string[] } {
  const empty: SimpleForm = {
    authors: '', eventId: '', replyTo: '', mentions: '', kinds: '',
    sinceUnix: null, untilUnix: null, limit: ''
  };
  let parsed: Record<string, unknown> = {};
  try {
    const v = JSON.parse(json);
    if (v && typeof v === 'object' && !Array.isArray(v)) parsed = v as Record<string, unknown>;
  } catch { return { form: empty, dropped: [] }; }

  const dropped = Object.keys(parsed).filter(k => !SIMPLE_KEYS.has(k));
  const authors = Array.isArray(parsed['authors']) ? (parsed['authors'] as unknown[]).join('\n') : '';
  const idsArr = Array.isArray(parsed['ids']) ? (parsed['ids'] as unknown[]) : [];
  const eventId = typeof idsArr[0] === 'string' ? idsArr[0] : '';
  const replyArr = Array.isArray(parsed['#e']) ? (parsed['#e'] as unknown[]) : [];
  const replyTo = typeof replyArr[0] === 'string' ? replyArr[0] : '';
  const mentions = Array.isArray(parsed['#p']) ? (parsed['#p'] as unknown[]).join('\n') : '';
  const kinds = Array.isArray(parsed['kinds']) ? (parsed['kinds'] as unknown[]).join(', ') : '';
  const sinceUnix = typeof parsed['since'] === 'number' ? parsed['since'] : null;
  const untilUnix = typeof parsed['until'] === 'number' ? parsed['until'] : null;
  const limit = typeof parsed['limit'] === 'number' ? String(parsed['limit']) : '';

  return { form: { authors, eventId, replyTo, mentions, kinds, sinceUnix, untilUnix, limit }, dropped };
}

function decodePubkey(raw: string): string | null {
  const t = raw.trim();
  if (/^[0-9a-fA-F]{64}$/.test(t)) return t.toLowerCase();
  if (t.startsWith('npub1')) {
    try {
      const d = nip19.decode(t);
      if (d.type === 'npub') return d.data;
    } catch {}
  }
  return null;
}

function decodeEventId(raw: string): string | null {
  const t = raw.trim();
  if (/^[0-9a-fA-F]{64}$/.test(t)) return t.toLowerCase();
  if (t.startsWith('note1')) {
    try {
      const d = nip19.decode(t);
      if (d.type === 'note') return d.data;
    } catch {}
  }
  if (t.startsWith('nevent1')) {
    try {
      const d = nip19.decode(t);
      if (d.type === 'nevent') return d.data.id;
    } catch {}
  }
  return null;
}

function buildJsonFromForm(form: SimpleForm): string {
  const obj: Record<string, unknown> = {};

  const authorList = form.authors.split('\n').map(s => s.trim()).filter(Boolean);
  if (authorList.length > 0) {
    const decoded: string[] = [];
    for (const raw of authorList) {
      const hex = decodePubkey(raw);
      if (!hex) throw new FilterValidationError(`invalid author: ${raw.slice(0, 16)}…`, 'authors');
      decoded.push(hex);
    }
    obj['authors'] = decoded;
  }

  const eventIdRaw = form.eventId.trim();
  if (eventIdRaw) {
    const hex = decodeEventId(eventIdRaw);
    if (!hex) throw new FilterValidationError(`invalid event id: ${eventIdRaw.slice(0, 16)}…`, 'ids');
    obj['ids'] = [hex];
  }

  const replyToRaw = form.replyTo.trim();
  if (replyToRaw) {
    const hex = decodeEventId(replyToRaw);
    if (!hex) throw new FilterValidationError(`invalid event id: ${replyToRaw.slice(0, 16)}…`, '#e');
    obj['#e'] = [hex];
  }

  const mentionList = form.mentions.split('\n').map(s => s.trim()).filter(Boolean);
  if (mentionList.length > 0) {
    const decoded: string[] = [];
    for (const raw of mentionList) {
      const hex = decodePubkey(raw);
      if (!hex) throw new FilterValidationError(`invalid pubkey: ${raw.slice(0, 16)}…`, '#p');
      decoded.push(hex);
    }
    obj['#p'] = decoded;
  }

  const kindsList = form.kinds.split(',').map(s => s.trim()).filter(Boolean);
  if (kindsList.length > 0) {
    const nums: number[] = [];
    for (const raw of kindsList) {
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 0 || n > 39_999) {
        throw new FilterValidationError(`invalid kind: ${raw}`, 'kinds');
      }
      nums.push(n);
    }
    obj['kinds'] = nums;
  }

  if (form.sinceUnix !== null) obj['since'] = form.sinceUnix;
  if (form.untilUnix !== null) obj['until'] = form.untilUnix;

  const limit = Number(form.limit);
  if (!Number.isInteger(limit) || limit < 1) {
    throw new FilterValidationError('"limit" must be a positive integer', 'limit');
  }
  obj['limit'] = limit;

  return JSON.stringify(obj, null, 2);
}
