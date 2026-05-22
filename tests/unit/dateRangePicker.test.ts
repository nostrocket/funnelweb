import { describe, test, expect, vi, beforeEach } from 'vitest';
import { mountDateRangePicker, type DateRange } from '../../src/ui/dateRangePicker';

function dayCellsInCurrentMonth(root: HTMLElement): HTMLButtonElement[] {
  return Array.from(root.querySelectorAll<HTMLButtonElement>('.cal-day:not(.muted)'));
}

function findDayCell(root: HTMLElement, day: number): HTMLButtonElement {
  const cell = dayCellsInCurrentMonth(root).find(c => c.textContent === String(day));
  if (!cell) throw new Error(`day ${day} not found in current view`);
  return cell;
}

function setViewToFebruary2026(root: HTMLElement): void {
  const label = root.querySelector('.cal-nav .label')!;
  const prev = root.querySelector<HTMLButtonElement>('.cal-nav button:nth-of-type(1)')!;
  const next = root.querySelector<HTMLButtonElement>('.cal-nav button:nth-of-type(2)')!;
  let safety = 24 * 20;
  while (label.textContent !== 'February 2026' && safety-- > 0) {
    const [, month, year] = (label.textContent ?? '').match(/^(\w+) (\d{4})$/) ?? [];
    if (!month || !year) break;
    const target = new Date(2026, 1, 1).getTime();
    const current = new Date(`${month} 1, ${year}`).getTime();
    if (current < target) next.click();
    else prev.click();
  }
  if (label.textContent !== 'February 2026') throw new Error('failed to navigate to February 2026');
}

describe('mountDateRangePicker', () => {
  let root: HTMLDivElement;
  let onChange: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    root = document.createElement('div');
    document.body.appendChild(root);
    onChange = vi.fn();
  });

  test('first click sets start; no onChange yet', () => {
    const picker = mountDateRangePicker(root, { onChange });
    setViewToFebruary2026(root);

    findDayCell(root, 10).click();

    expect(onChange).not.toHaveBeenCalled();
    expect(picker.getRange()).toEqual({ sinceUnix: null, untilUnix: null });
    expect(findDayCell(root, 10).classList.contains('range-start')).toBe(true);
  });

  test('second click later than start completes the range and fires onChange once', () => {
    mountDateRangePicker(root, { onChange });
    setViewToFebruary2026(root);

    findDayCell(root, 10).click();
    findDayCell(root, 14).click();

    expect(onChange).toHaveBeenCalledTimes(1);
    const r = onChange.mock.calls[0]![0] as DateRange;
    expect(r.sinceUnix).not.toBeNull();
    expect(r.untilUnix).not.toBeNull();

    const sinceDate = new Date((r.sinceUnix as number) * 1000);
    expect(sinceDate.getFullYear()).toBe(2026);
    expect(sinceDate.getMonth()).toBe(1);
    expect(sinceDate.getDate()).toBe(10);
    expect(sinceDate.getHours()).toBe(0);
    expect(sinceDate.getMinutes()).toBe(0);
    expect(sinceDate.getSeconds()).toBe(0);

    const untilDate = new Date((r.untilUnix as number) * 1000);
    expect(untilDate.getDate()).toBe(14);
    expect(untilDate.getHours()).toBe(23);
    expect(untilDate.getMinutes()).toBe(59);
    expect(untilDate.getSeconds()).toBe(59);
  });

  test('second click earlier than start resets start; no onChange', () => {
    mountDateRangePicker(root, { onChange });
    setViewToFebruary2026(root);

    findDayCell(root, 10).click();
    findDayCell(root, 5).click();

    expect(onChange).not.toHaveBeenCalled();
    expect(findDayCell(root, 5).classList.contains('range-start')).toBe(true);
    expect(findDayCell(root, 10).classList.contains('range-start')).toBe(false);
  });

  test('click after a complete range starts a fresh selection', () => {
    mountDateRangePicker(root, { onChange });
    setViewToFebruary2026(root);

    findDayCell(root, 10).click();
    findDayCell(root, 14).click();
    expect(onChange).toHaveBeenCalledTimes(1);

    findDayCell(root, 20).click();
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(findDayCell(root, 20).classList.contains('range-start')).toBe(true);
    expect(findDayCell(root, 14).classList.contains('range-end')).toBe(false);
  });

  test('setRange updates DOM without firing onChange', () => {
    const picker = mountDateRangePicker(root, { onChange });

    const sinceDate = new Date(2026, 1, 10, 0, 0, 0, 0);
    const untilDate = new Date(2026, 1, 14, 23, 59, 59, 999);
    const range: DateRange = {
      sinceUnix: Math.floor(sinceDate.getTime() / 1000),
      untilUnix: Math.floor(untilDate.getTime() / 1000)
    };
    picker.setRange(range);

    expect(onChange).not.toHaveBeenCalled();
    expect(picker.getRange()).toEqual(range);

    const label = root.querySelector('.cal-nav .label')!;
    expect(label.textContent).toBe('February 2026');
    expect(findDayCell(root, 10).classList.contains('range-start')).toBe(true);
    expect(findDayCell(root, 14).classList.contains('range-end')).toBe(true);
    expect(findDayCell(root, 12).classList.contains('in-range')).toBe(true);
  });

  test('clear button fires onChange with both null', () => {
    const picker = mountDateRangePicker(root, { onChange });
    setViewToFebruary2026(root);

    findDayCell(root, 10).click();
    findDayCell(root, 14).click();
    onChange.mockClear();

    const clearBtn = root.querySelectorAll<HTMLButtonElement>('.cal-nav button')[2]!;
    clearBtn.click();

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0]![0]).toEqual({ sinceUnix: null, untilUnix: null });
    expect(picker.getRange()).toEqual({ sinceUnix: null, untilUnix: null });
  });

  test('clear button on already-empty range is a no-op', () => {
    mountDateRangePicker(root, { onChange });
    const clearBtn = root.querySelectorAll<HTMLButtonElement>('.cal-nav button')[2]!;
    clearBtn.click();
    expect(onChange).not.toHaveBeenCalled();
  });

  test('same-day click is a valid 1-day range', () => {
    mountDateRangePicker(root, { onChange });
    setViewToFebruary2026(root);

    findDayCell(root, 10).click();
    findDayCell(root, 10).click();

    expect(onChange).toHaveBeenCalledTimes(1);
    const r = onChange.mock.calls[0]![0] as DateRange;
    const since = new Date((r.sinceUnix as number) * 1000);
    const until = new Date((r.untilUnix as number) * 1000);
    expect(since.getDate()).toBe(10);
    expect(until.getDate()).toBe(10);
    expect((r.untilUnix as number) - (r.sinceUnix as number)).toBe(86399);
  });
});
