import { error } from './log';

type Listener<T> = (value: T, prev: T) => void;

export class Store<T extends object> {
  private value: T;
  private listeners = new Set<Listener<T>>();
  private persistFn: ((t: T) => Promise<void>) | null = null;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private persistDelay = 200;

  constructor(initial: T) {
    this.value = initial;
  }

  get(): T { return this.value; }

  set(patch: Partial<T>): void {
    const prev = this.value;
    this.value = { ...prev, ...patch };
    this.emit(prev);
    this.schedulePersist();
  }

  update(fn: (current: T) => T): void {
    const prev = this.value;
    this.value = fn(prev);
    this.emit(prev);
    this.schedulePersist();
  }

  subscribe(listener: Listener<T>): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  bindPersistence(save: (t: T) => Promise<void>, debounceMs = 200): void {
    this.persistFn = save;
    this.persistDelay = debounceMs;
  }

  flushPersist(): Promise<void> {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    if (!this.persistFn) return Promise.resolve();
    return this.persistFn(this.value);
  }

  private emit(prev: T): void {
    for (const l of this.listeners) {
      try { l(this.value, prev); }
      catch (e) { error('store', 'listener threw', e); }
    }
  }

  private schedulePersist(): void {
    if (!this.persistFn) return;
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      const fn = this.persistFn;
      const v = this.value;
      if (fn) fn(v).catch(e => error('store', 'persist failed', e));
    }, this.persistDelay);
  }
}

export interface Bus<T> {
  emit(v: T): void;
  subscribe(cb: (v: T) => void): () => void;
}

export function createBus<T>(): Bus<T> {
  const subs = new Set<(v: T) => void>();
  return {
    emit(v) {
      for (const cb of subs) {
        try { cb(v); } catch (e) { error('bus', 'subscriber threw', e); }
      }
    },
    subscribe(cb) { subs.add(cb); return () => { subs.delete(cb); }; }
  };
}
