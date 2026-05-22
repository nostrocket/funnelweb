import { describe, test, expect } from 'vitest';
import { BoundedQueue } from '../../src/core/boundedQueue';

describe('BoundedQueue', () => {
  test('drops on overflow and counts drops', () => {
    const q = new BoundedQueue<number>(2);
    expect(q.push(1)).toBe(true);
    expect(q.push(2)).toBe(true);
    expect(q.push(3)).toBe(false);
    expect(q.stats().dropped).toBe(1);
    expect(q.shift()).toBe(1);
    expect(q.shift()).toBe(2);
    expect(q.shift()).toBeUndefined();
  });

  test('resize truncates from the head', () => {
    const q = new BoundedQueue<number>(4);
    q.push(1); q.push(2); q.push(3); q.push(4);
    q.resize(2);
    expect(q.length).toBe(2);
    expect(q.shift()).toBe(3);
    expect(q.shift()).toBe(4);
  });

  test('clear empties without changing capacity', () => {
    const q = new BoundedQueue<number>(2);
    q.push(1); q.clear();
    expect(q.length).toBe(0);
    expect(q.push(1)).toBe(true);
  });
});
