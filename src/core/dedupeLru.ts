export class DedupeLru {
  private map = new Map<string, null>();
  private cap: number;

  constructor(capacity: number) {
    if (capacity < 1) throw new Error('capacity must be >= 1');
    this.cap = capacity;
  }

  has(id: string): boolean { return this.map.has(id); }

  add(id: string): boolean {
    if (this.map.has(id)) return false;
    this.map.set(id, null);
    while (this.map.size > this.cap) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
    return true;
  }

  size(): number { return this.map.size; }
  clear(): void { this.map.clear(); }

  resize(capacity: number): void {
    if (capacity < 1) throw new Error('capacity must be >= 1');
    this.cap = capacity;
    while (this.map.size > capacity) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }
}
