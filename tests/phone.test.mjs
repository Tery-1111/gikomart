import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { normalizeContactNumber, contactHash } = require('../src/utils/phone.js');

describe('normalizeContactNumber', () => {
  it('normalizes the common Kenyan formats to the same 2547... value', () => {
    expect(normalizeContactNumber('0712222222')).toBe('254712222222');
    expect(normalizeContactNumber('+254 712 222 222')).toBe('254712222222');
    expect(normalizeContactNumber('254712222222')).toBe('254712222222');
    expect(normalizeContactNumber('712222222')).toBe('254712222222');
  });

  it('normalizes a 01 number to 2541...', () => {
    expect(normalizeContactNumber('0112345678')).toBe('254112345678');
  });

  it('returns null for non-strings and invalid values', () => {
    for (const bad of [123, {}, [], null, undefined, true]) {
      expect(normalizeContactNumber(bad)).toBeNull();
    }
    for (const bad of ['', 'abc', '12345']) {
      expect(normalizeContactNumber(bad)).toBeNull();
    }
  });
});

describe('contactHash', () => {
  it('produces the same hash for every equivalent format', () => {
    const expected = contactHash('0712222222');
    expect(contactHash('+254 712 222 222')).toBe(expected);
    expect(contactHash('254712222222')).toBe(expected);
    expect(contactHash('712222222')).toBe(expected);
  });

  it('produces different hashes for different numbers', () => {
    expect(contactHash('0712222222')).not.toBe(contactHash('0712222223'));
  });

  it('is a 64-character hex digest', () => {
    expect(contactHash('0712222222')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('returns null when the value does not normalize', () => {
    for (const bad of [123, null, undefined, '', 'abc', '12345']) {
      expect(contactHash(bad)).toBeNull();
    }
  });
});
