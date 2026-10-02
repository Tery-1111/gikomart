import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { checkListing, checkStore, FLAGGED_PATTERNS, SCAM_PATTERNS } = require('../src/services/moderationService.js');

describe('moderationService — checkStore', () => {
  it('flags a store whose name matches a phrase checkListing flags in a title', () => {
    // The same phrase must trip the shared runner regardless of which field
    // carries it: listings check title, stores check name.
    expect(checkListing({ title: 'Campus Casino Night' }).approved).toBe(false);
    const result = checkStore({ name: 'Campus Casino Supplies' });
    expect(result.approved).toBe(false);
    expect(result.flaggedBy).toEqual([{ pattern: 'gambling|betting|casino' }]);
  });

  it('flags a prohibited phrase placed only in description', () => {
    const result = checkStore({ name: 'Clean Shop', description: 'Cheap stolen phones for sale' });
    expect(result.approved).toBe(false);
    expect(result.flaggedBy.length).toBeGreaterThan(0);
  });

  it('flags a prohibited phrase placed only inside the payment_methods array', () => {
    const result = checkStore({ name: 'Clean Shop', payment_methods: ['M-Pesa', 'Pay First'] });
    expect(result.approved).toBe(false);
    expect(result.flaggedBy.length).toBeGreaterThan(0);
  });

  it('approves a clean store and returns the same approved shape as checkListing', () => {
    const clean = checkStore({
      name: 'Njoro Electronics',
      description: 'Phones and accessories',
      category: 'Electronics',
      subcategories: ['Phones', 'Chargers'],
      location: 'Njoro',
      pickup_location: 'Main gate',
      opening_hours: '08:00',
      closing_hours: '18:00',
      open_days: 'Mon-Sat',
      payment_methods: ['M-Pesa', 'Cash'],
    });
    expect(clean).toEqual({ approved: true, flaggedBy: [] });
    expect(checkListing({ title: 'Phones and accessories' }).approved).toBe(true);
  });

  it('does not throw on {} or null-valued fields, and approves them', () => {
    expect(checkStore({})).toEqual({ approved: true, flaggedBy: [] });
    expect(checkStore({ name: null, description: undefined, subcategories: null, payment_methods: null }))
      .toEqual({ approved: true, flaggedBy: [] });
    expect(checkStore(null)).toEqual({ approved: true, flaggedBy: [] });
  });

  it('keeps the exported pattern lists unchanged in shape', () => {
    expect(Array.isArray(FLAGGED_PATTERNS)).toBe(true);
    expect(Array.isArray(SCAM_PATTERNS)).toBe(true);
    expect(FLAGGED_PATTERNS.length).toBeGreaterThan(0);
  });
});

describe('moderationService — checkListing after the shared-runner extraction', () => {
  it('returns identical results for a clean listing', () => {
    expect(checkListing({ title: 'Study Desk', description: 'Wooden desk, good condition' }))
      .toEqual({ approved: true, flaggedBy: [] });
  });

  it('returns identical results for a flagged listing', () => {
    expect(checkListing({ title: 'Casino night tickets' }))
      .toEqual({ approved: false, flaggedBy: [{ pattern: 'gambling|betting|casino' }] });
  });

  it('flags multiple patterns in order, combining FLAGGED and SCAM', () => {
    const result = checkListing({ title: 'Casino night', description: 'Accepted via PayPal gift' });
    expect(result.approved).toBe(false);
    expect(result.flaggedBy.map((m) => m.pattern)).toEqual([
      'gambling|betting|casino',
      '\\bpaypal\\s*gift',
    ]);
  });
});
