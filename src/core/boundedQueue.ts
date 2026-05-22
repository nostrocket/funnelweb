export interface BoundedQueueStats {
  enqueued: number;
  dropped: number;
  size: number;
}

export class BoundedQueue<T> {
  private buf: T[] = [];
  private cap: number;
  private enqueued = 0;
  private dropped = 0;

  constructor(capacity: number) {
    if (capacity < 1) throw new Error('capacity must be >= 1');
    this.cap = capacity;
  }

  push(item: T): boolean {
    if (this.buf.length >= this.cap) {
      this.dropped++;
      return false;
    }
    this.buf.push(item);
    this.enqueued++;
    return true;
  }

  shift(): T | undefined { return this.buf.shift(); }
  peek(): T | undefined { return this.buf[0]; }

  get length(): number { return this.buf.length; }
  get capacity(): number { return this.cap; }

  stats(): BoundedQueueStats {
    return { enqueued: this.enqueued, dropped: this.dropped, size: this.buf.length };
  }

  resize(newCapacity: number): void {
    if (newCapacity < 1) throw new Error('capacity must be >= 1');
    this.cap = newCapacity;
    if (this.buf.length > newCapacity) {
      this.buf.splice(0, this.buf.length - newCapacity);
    }
  }

  clear(): void { this.buf.length = 0; }
}
