import { describe, test, expect } from 'vitest';
import { DedupeLru } from '../../src/core/dedupeLru';

describe('DedupeLru', () => {
  test('add returns false on duplicate', () => {
    const d = new DedupeLru(3);
    expect(d.add('a')).toBe(true);
    expect(d.add('a')).toBe(false);
  });

  test('evicts oldest when at capacity', () => {
    const d = new DedupeLru(3);
    d.add('a'); d.add('b'); d.add('c'); d.add('d');
    expect(d.has('a')).toBe(false);
    expect(d.has('b')).toBe(true);
    expect(d.has('c')).toBe(true);
    expect(d.has('d')).toBe(true);
    expect(d.size()).toBe(3);
  });

  test('resize trims', () => {
    const d = new DedupeLru(3);
    d.add('a'); d.add('b'); d.add('c');
    d.resize(2);
    expect(d.size()).toBe(2);
    expect(d.has('a')).toBe(false);
  });
});
