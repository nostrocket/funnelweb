import { describe, test, expect } from 'vitest';
import { validateFilterJson, FilterValidationError } from '../../src/core/filterValidator';

describe('validateFilterJson', () => {
  test('rejects unbounded filter (no limit)', () => {
    expect(() => validateFilterJson('{"kinds":[1]}', 500)).toThrow(FilterValidationError);
  });

  test('accepts bounded kinds+limit', () => {
    const { filter } = validateFilterJson('{"kinds":[1],"limit":200}', 500);
    expect(filter.limit).toBe(200);
  });

  test('rejects limit over max', () => {
    expect(() => validateFilterJson('{"kinds":[1],"limit":5000}', 500)).toThrow(FilterValidationError);
  });

  test('rejects authors that are not 64-char hex', () => {
    expect(() => validateFilterJson('{"authors":["nope"],"limit":1}', 500)).toThrow(FilterValidationError);
  });

  test('accepts 64-char hex authors', () => {
    const hex = 'a'.repeat(64);
    const { filter } = validateFilterJson(`{"authors":["${hex}"],"limit":10}`, 500);
    expect(filter.authors?.[0]).toBe(hex);
  });

  test('warns on millisecond-looking since', () => {
    const ms = 1_700_000_000_000;
    const { warnings } = validateFilterJson(`{"kinds":[1],"since":${ms},"limit":1}`, 500);
    expect(warnings.some(w => w.includes('milliseconds'))).toBe(true);
  });

  test('rejects non-object filter', () => {
    expect(() => validateFilterJson('[]', 500)).toThrow(FilterValidationError);
    expect(() => validateFilterJson('"x"', 500)).toThrow(FilterValidationError);
  });

  test('truncates oversized tag arrays', () => {
    const tags = Array.from({ length: 300 }, (_, i) => `t${i}`);
    const json = JSON.stringify({ '#t': tags, kinds: [1], limit: 1 });
    const { filter, warnings } = validateFilterJson(json, 500);
    const tArr = (filter as Record<string, unknown>)['#t'] as string[];
    expect(tArr.length).toBe(256);
    expect(warnings.some(w => w.includes('truncated'))).toBe(true);
  });

  test('rejects malformed kind range', () => {
    expect(() => validateFilterJson('{"kinds":[40000],"limit":1}', 500)).toThrow(FilterValidationError);
  });

  test('accepts ids as the sole anchor', () => {
    const hex = 'b'.repeat(64);
    const { filter } = validateFilterJson(`{"ids":["${hex}"],"limit":1}`, 500);
    expect(filter.ids?.[0]).toBe(hex);
  });

  test('accepts #e as the sole anchor', () => {
    const hex = 'c'.repeat(64);
    const json = JSON.stringify({ '#e': [hex], limit: 1 });
    const { filter } = validateFilterJson(json, 500);
    const e = (filter as Record<string, unknown>)['#e'] as string[];
    expect(e[0]).toBe(hex);
  });

  test('rejects filter with only limit (no anchor at all)', () => {
    expect(() => validateFilterJson('{"limit":1}', 500)).toThrow(FilterValidationError);
  });
});
