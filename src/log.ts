import type { LogLevel } from './types';

interface LogEntry { ts: number; level: LogLevel; tag: string; msg: string; }

const buffer: LogEntry[] = [];
const MAX = 2_000;
let mirrorEl: HTMLElement | null = null;

export function attachConsole(el: HTMLElement): void {
  mirrorEl = el;
  el.hidden = false;
  render();
}

function render(): void {
  if (!mirrorEl) return;
  const lines = buffer.slice(-200).map(e => {
    const t = new Date(e.ts).toISOString().slice(11, 23);
    return `${t} [${e.level}] ${e.tag}: ${e.msg}`;
  });
  mirrorEl.textContent = lines.join('\n');
  mirrorEl.scrollTop = mirrorEl.scrollHeight;
}

function fmtRest(rest: unknown[]): string {
  if (rest.length === 0) return '';
  return ' ' + rest.map(v => {
    if (v instanceof Error) return v.message;
    if (typeof v === 'string') return v;
    try { return JSON.stringify(v); } catch { return String(v); }
  }).join(' ');
}

export function log(level: LogLevel, tag: string, msg: string, ...rest: unknown[]): void {
  const entry: LogEntry = { ts: Date.now(), level, tag, msg: msg + fmtRest(rest) };
  buffer.push(entry);
  if (buffer.length > MAX) buffer.splice(0, buffer.length - MAX);
  // Also forward to the dev console for stack traces / inspector access.
  const fn = level === 'error' ? console.error
            : level === 'warn'  ? console.warn
            : level === 'info'  ? console.info
            : console.debug;
  fn(`[${tag}]`, msg, ...rest);
  render();
}

export function debug(tag: string, msg: string, ...rest: unknown[]): void { log('debug', tag, msg, ...rest); }
export function info (tag: string, msg: string, ...rest: unknown[]): void { log('info',  tag, msg, ...rest); }
export function warn (tag: string, msg: string, ...rest: unknown[]): void { log('warn',  tag, msg, ...rest); }
export function error(tag: string, msg: string, ...rest: unknown[]): void { log('error', tag, msg, ...rest); }

export function snapshot(): readonly LogEntry[] { return buffer.slice(); }
