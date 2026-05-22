import { el, clearChildren } from './components';

export interface DateRange {
  sinceUnix: number | null;
  untilUnix: number | null;
}

export interface DateRangePickerHandle {
  getRange(): DateRange;
  setRange(r: DateRange): void;
  clear(): void;
}

export interface DateRangePickerOpts {
  onChange: (r: DateRange) => void;
}

const WEEKDAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'] as const;
const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
] as const;

export function mountDateRangePicker(
  root: HTMLElement,
  opts: DateRangePickerOpts
): DateRangePickerHandle {
  clearChildren(root);
  root.classList.add('cal');

  const today = new Date();
  let viewYear = today.getFullYear();
  let viewMonth = today.getMonth();
  let start: Date | null = null;
  let end: Date | null = null;
  let hover: Date | null = null;

  const presetsRow = el('div', { class: 'cal-presets' });
  const PRESETS: ReadonlyArray<{ label: string; seconds: number }> = [
    { label: '24h', seconds: 24 * 3600 },
    { label: '3d', seconds: 3 * 24 * 3600 },
    { label: '1w', seconds: 7 * 24 * 3600 },
    { label: '1m', seconds: 30 * 24 * 3600 }
  ];
  for (const p of PRESETS) {
    const b = el('button', { type: 'button' }, [`Last ${p.label}`]) as HTMLButtonElement;
    b.addEventListener('click', () => applyPreset(p.seconds));
    presetsRow.appendChild(b);
  }

  const navRow = el('div', { class: 'cal-nav' });
  const prevBtn = el('button', { type: 'button' }, ['‹']) as HTMLButtonElement;
  const nextBtn = el('button', { type: 'button' }, ['›']) as HTMLButtonElement;
  const monthLabel = el('div', { class: 'label' });
  const clearBtn = el('button', { type: 'button' }, ['Clear']) as HTMLButtonElement;
  navRow.append(prevBtn, monthLabel, nextBtn, clearBtn);

  const grid = el('div', { class: 'cal-grid' });
  const summary = el('div', { class: 'cal-summary' });

  root.append(presetsRow, navRow, grid, summary);

  function applyPreset(seconds: number): void {
    const nowMs = Date.now();
    const sinceMs = nowMs - seconds * 1000;
    start = new Date(sinceMs);
    end = new Date(nowMs);
    hover = null;
    viewYear = start.getFullYear();
    viewMonth = start.getMonth();
    render();
    opts.onChange({
      sinceUnix: Math.floor(sinceMs / 1000),
      untilUnix: Math.floor(nowMs / 1000)
    });
  }

  prevBtn.addEventListener('click', () => {
    if (viewMonth === 0) { viewMonth = 11; viewYear -= 1; }
    else { viewMonth -= 1; }
    render();
  });
  nextBtn.addEventListener('click', () => {
    if (viewMonth === 11) { viewMonth = 0; viewYear += 1; }
    else { viewMonth += 1; }
    render();
  });
  clearBtn.addEventListener('click', () => {
    if (start === null && end === null) return;
    start = null;
    end = null;
    hover = null;
    render();
    opts.onChange({ sinceUnix: null, untilUnix: null });
  });

  function dayKey(d: Date): number {
    return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
  }

  function startOfDayUnix(d: Date): number {
    const x = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
    return Math.floor(x.getTime() / 1000);
  }

  function endOfDayUnix(d: Date): number {
    const x = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);
    return Math.floor(x.getTime() / 1000);
  }

  function fmt(d: Date): string {
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  function pickDay(d: Date): void {
    if (start === null || (start !== null && end !== null)) {
      start = d;
      end = null;
      hover = null;
      render();
      return;
    }
    if (dayKey(d) < dayKey(start)) {
      start = d;
      end = null;
      hover = null;
      render();
      return;
    }
    end = d;
    hover = null;
    render();
    opts.onChange({ sinceUnix: startOfDayUnix(start), untilUnix: endOfDayUnix(end) });
  }

  function setHover(d: Date | null): void {
    if (start === null || end !== null) return;
    const a = hover === null ? null : dayKey(hover);
    const b = d === null ? null : dayKey(d);
    if (a === b) return;
    hover = d;
    renderHighlights();
  }

  function inRange(d: Date): { start: boolean; end: boolean; mid: boolean } {
    if (start === null) return { start: false, end: false, mid: false };
    const dk = dayKey(d);
    const sk = dayKey(start);
    if (end !== null) {
      const ek = dayKey(end);
      return {
        start: dk === sk,
        end: dk === ek,
        mid: dk > sk && dk < ek
      };
    }
    if (hover !== null) {
      const hk = dayKey(hover);
      if (hk >= sk) {
        return { start: dk === sk, end: dk === hk && hk !== sk, mid: dk > sk && dk < hk };
      }
    }
    return { start: dk === sk, end: false, mid: false };
  }

  function render(): void {
    monthLabel.textContent = `${MONTHS[viewMonth]} ${viewYear}`;
    clearChildren(grid);
    for (const w of WEEKDAYS) grid.appendChild(el('div', { class: 'weekday' }, [w]));

    const firstOfMonth = new Date(viewYear, viewMonth, 1);
    const startWeekday = firstOfMonth.getDay();
    const gridStart = new Date(viewYear, viewMonth, 1 - startWeekday);

    for (let i = 0; i < 42; i++) {
      const d = new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + i);
      const cell = el('button', { type: 'button', class: 'cal-day' }, [String(d.getDate())]) as HTMLButtonElement;
      if (d.getMonth() !== viewMonth) cell.classList.add('muted');
      cell.dataset['key'] = String(dayKey(d));
      cell.addEventListener('click', () => pickDay(d));
      cell.addEventListener('mouseenter', () => setHover(d));
      grid.appendChild(cell);
    }
    renderHighlights();
    renderSummary();
  }

  function renderHighlights(): void {
    const cells = grid.querySelectorAll<HTMLButtonElement>('.cal-day');
    cells.forEach(cell => {
      const k = Number(cell.dataset['key']);
      const y = Math.floor(k / 10000);
      const m = Math.floor((k % 10000) / 100) - 1;
      const day = k % 100;
      const d = new Date(y, m, day);
      const r = inRange(d);
      cell.classList.toggle('range-start', r.start);
      cell.classList.toggle('range-end', r.end);
      cell.classList.toggle('in-range', r.mid);
    });
  }

  function renderSummary(): void {
    const s = start !== null ? fmt(start) : '—';
    const e = end !== null ? fmt(end) : '—';
    summary.textContent = `Since: ${s}   Until: ${e}`;
  }

  function getRange(): DateRange {
    if (start === null || end === null) return { sinceUnix: null, untilUnix: null };
    return { sinceUnix: startOfDayUnix(start), untilUnix: endOfDayUnix(end) };
  }

  function setRange(r: DateRange): void {
    start = r.sinceUnix !== null ? new Date(r.sinceUnix * 1000) : null;
    end = r.untilUnix !== null ? new Date(r.untilUnix * 1000) : null;
    hover = null;
    if (start !== null) {
      viewYear = start.getFullYear();
      viewMonth = start.getMonth();
    }
    render();
  }

  function clear(): void {
    start = null;
    end = null;
    hover = null;
    render();
  }

  render();

  return { getRange, setRange, clear };
}
