import { describe, it, expect, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';

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

describe('contactHash — keyed with BLOCK_HASH_SECRET', () => {
  const ORIGINAL_SECRET = process.env.BLOCK_HASH_SECRET;
  const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

  afterEach(() => {
    if (ORIGINAL_SECRET === undefined) delete process.env.BLOCK_HASH_SECRET;
    else process.env.BLOCK_HASH_SECRET = ORIGINAL_SECRET;
    if (ORIGINAL_NODE_ENV === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = ORIGINAL_NODE_ENV;
  });

  const SECRET_20 = '0123456789abcdefghij'; // 20 characters

  it('gives the same hash for every equivalent format', () => {
    process.env.BLOCK_HASH_SECRET = SECRET_20;
    const expected = contactHash('0712222222');
    expect(contactHash('+254 712 222 222')).toBe(expected);
    expect(contactHash('254712222222')).toBe(expected);
  });

  it('gives different hashes for different secrets', () => {
    process.env.BLOCK_HASH_SECRET = SECRET_20;
    const first = contactHash('0712222222');
    process.env.BLOCK_HASH_SECRET = '9876543210zyxwvutsrq'; // 20 characters
    expect(contactHash('0712222222')).not.toBe(first);
  });

  it('is not the plain sha256 of the normalized number', () => {
    process.env.BLOCK_HASH_SECRET = SECRET_20;
    const plain = crypto.createHash('sha256').update('254712222222').digest('hex');
    expect(contactHash('0712222222')).not.toBe(plain);
  });

  it('throws in production when no secret is configured', () => {
    delete process.env.BLOCK_HASH_SECRET;
    process.env.NODE_ENV = 'production';
    expect(() => contactHash('0712222222')).toThrow();
  });

  it('throws in production with a 15-character secret but not a 16-character one', () => {
    process.env.NODE_ENV = 'production';
    process.env.BLOCK_HASH_SECRET = 'abcdefghijklmno'; // 15 characters
    expect(() => contactHash('0712222222')).toThrow();
    process.env.BLOCK_HASH_SECRET = 'abcdefghijklmnop'; // 16 characters
    expect(contactHash('0712222222')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('returns a 64-hex hash in test with no secret', () => {
    delete process.env.BLOCK_HASH_SECRET;
    process.env.NODE_ENV = 'test';
    expect(contactHash('0712222222')).toMatch(/^[0-9a-f]{64}$/);
  });
});
