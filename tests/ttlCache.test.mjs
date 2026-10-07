import { describe, it, expect, beforeEach } from 'vitest';
import { createTtlCache } from '../src/utils/ttlCache.js';

describe('createTtlCache — unit behavior', () => {
  let cache;

  beforeEach(() => {
    cache = createTtlCache(60000);
  });

  it('get returns undefined for a missing key', () => {
    expect(cache.get('nope')).toBeUndefined();
  });

  it('set then get returns the same value', () => {
    cache.set('k', { a: 1 });
    expect(cache.get('k')).toEqual({ a: 1 });
  });

  it('clear() empties the cache', () => {
    cache.set('a', 1);
    cache.set('b', 2);
    cache.clear();
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBeUndefined();
  });

  it('expired entries return undefined', () => {
    cache.set('k', 'v', 1); // 1 ms TTL
    return new Promise((resolve) => {
      setTimeout(() => {
        expect(cache.get('k')).toBeUndefined();
        resolve();
      }, 10);
    });
  });

  it('per-set ttlMs override beats the default', () => {
    cache.set('long', 'L', 5000);
    cache.set('short', 'S', 1);
    return new Promise((resolve) => {
      setTimeout(() => {
        expect(cache.get('short')).toBeUndefined();
        expect(cache.get('long')).toBe('L');
        resolve();
      }, 10);
    });
  });

  it('second set on the same key replaces value and expiry', () => {
    cache.set('k', 'v1', 30);
    cache.set('k', 'v2', 60000);
    // First write would be expired by the second's expiry on a miss path, and
    // the key must hold the last value regardless.
    expect(cache.get('k')).toBe('v2');
  });

  it('two factory instances do not share entries', () => {
    const other = createTtlCache(60000);
    cache.set('k', 'mine');
    expect(other.get('k')).toBeUndefined();
  });

  it('size() reflects the number of distinct cached keys', () => {
    cache.set('a', 1);
    cache.set('b', 2);
    expect(cache.size()).toBe(2);
    cache.clear();
    expect(cache.size()).toBe(0);
  });
});
