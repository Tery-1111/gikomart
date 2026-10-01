import { describe, it, expect } from 'vitest';
import { redact } from '../src/utils/redact.js';

describe('redact()', () => {
  it('redacts a top-level sensitive key', () => {
    const out = redact({ token: 'raw-secret-abc', safe: 'visible' });
    expect(out.token).toBe('[REDACTED]');
  });

  it('preserves non-sensitive keys', () => {
    const out = redact({ reason: 'bad-challenge', count: 3, ok: true });
    expect(out).toEqual({ reason: 'bad-challenge', count: 3, ok: true });
  });

  it('recurses into nested objects', () => {
    const out = redact({ outer: { inner: { password: 'hunter2', keep: 'x' } } });
    expect(out.outer.inner.password).toBe('[REDACTED]');
    expect(out.outer.inner.keep).toBe('x');
  });

  it('redacts per element inside arrays', () => {
    const out = redact({ items: [{ email: 'a@b.c' }, { email: 'd@e.f', id: 1 }] });
    expect(out.items[0].email).toBe('[REDACTED]');
    expect(out.items[1].email).toBe('[REDACTED]');
    expect(out.items[1].id).toBe(1);
  });

  it('does not mutate its input', () => {
    const input = { token: 'raw', nested: { phoneNumber: '0712345678' } };
    const before = JSON.stringify(input);
    redact(input);
    expect(JSON.stringify(input)).toBe(before);
  });

  it('replaces a non-string value under a redacted key regardless of type', () => {
    const out = redact({
      phone: 254712345678,
      secret: { nested: 'object' },
      authorization: ['a', 'b'],
    });
    expect(out.phone).toBe('[REDACTED]');
    expect(out.secret).toBe('[REDACTED]');
    expect(out.authorization).toBe('[REDACTED]');
  });
});
