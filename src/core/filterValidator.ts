import type { Filter as NostrFilter } from 'nostr-tools';

export interface ValidatedFilter {
  filter: NostrFilter;
  warnings: string[];
}

export class FilterValidationError extends Error {
  constructor(message: string, public readonly path?: string) {
    super(message);
    this.name = 'FilterValidationError';
  }
}

const HEX64 = /^[0-9a-f]{64}$/;

export function validateFilterJson(json: string, maxLimit: number): ValidatedFilter {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (e) {
    throw new FilterValidationError(`invalid JSON: ${(e as Error).message}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new FilterValidationError('filter must be a JSON object');
  }
  const obj = parsed as Record<string, unknown>;
  const warnings: string[] = [];

  const hasTagAnchor = Object.keys(obj).some(k => k.startsWith('#') && Array.isArray(obj[k]));
  const hasAnchor =
    Array.isArray(obj['authors']) ||
    Array.isArray(obj['ids']) ||
    Array.isArray(obj['kinds']) ||
    typeof obj['since'] === 'number' ||
    typeof obj['until'] === 'number' ||
    hasTagAnchor;
  if (!hasAnchor) {
    throw new FilterValidationError('filter must include at least one of: authors, ids, kinds, since, until, or a #tag');
  }

  if (!('limit' in obj)) {
    throw new FilterValidationError('filter must include "limit"');
  }
  const limit = obj['limit'];
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1) {
    throw new FilterValidationError('"limit" must be an integer >= 1', 'limit');
  }
  if (limit > maxLimit) {
    throw new FilterValidationError(`"limit" must be <= ${maxLimit}`, 'limit');
  }

  if ('authors' in obj) {
    const a = obj['authors'];
    if (!Array.isArray(a)) throw new FilterValidationError('"authors" must be an array', 'authors');
    for (const v of a) {
      if (typeof v !== 'string' || !HEX64.test(v)) {
        throw new FilterValidationError('"authors" entries must be 64-char lowercase hex', 'authors');
      }
    }
  }
  if ('ids' in obj) {
    const a = obj['ids'];
    if (!Array.isArray(a)) throw new FilterValidationError('"ids" must be an array', 'ids');
    for (const v of a) {
      if (typeof v !== 'string' || !HEX64.test(v)) {
        throw new FilterValidationError('"ids" entries must be 64-char lowercase hex', 'ids');
      }
    }
  }
  if ('kinds' in obj) {
    const a = obj['kinds'];
    if (!Array.isArray(a)) throw new FilterValidationError('"kinds" must be an array', 'kinds');
    for (const v of a) {
      if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 39_999) {
        throw new FilterValidationError('"kinds" entries must be integers in [0, 39999]', 'kinds');
      }
    }
  }
  for (const k of ['since', 'until'] as const) {
    if (k in obj) {
      const v = obj[k];
      if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) {
        throw new FilterValidationError(`"${k}" must be a non-negative integer (unix seconds)`, k);
      }
      if (v >= 10_000_000_000) {
        warnings.push(`"${k}" looks like milliseconds; expected unix seconds`);
      }
    }
  }

  // Tag filters: keys starting with "#" must be arrays of strings; truncate to 256.
  const filter = { ...obj } as Record<string, unknown>;
  for (const key of Object.keys(filter)) {
    if (!key.startsWith('#')) continue;
    const v = filter[key];
    if (!Array.isArray(v)) {
      throw new FilterValidationError(`"${key}" tag filter must be an array`, key);
    }
    for (const item of v) {
      if (typeof item !== 'string') {
        throw new FilterValidationError(`"${key}" entries must be strings`, key);
      }
    }
    if (v.length > 256) {
      filter[key] = v.slice(0, 256);
      warnings.push(`"${key}" truncated to 256 entries`);
    }
  }

  return { filter: filter as unknown as NostrFilter, warnings };
}
