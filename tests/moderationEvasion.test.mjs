// Phase 8b Step 2 — moderation matching also tests a normalized copy of the text
// (look-alike digits/symbols next to letters, zero-width characters, full-width
// letters) and a copy with single-letter spacing removed. The control phrase is
// built from a real FLAGGED_PATTERNS entry, and twelve clean strings must stay
// approved so the normalization does not create false positives.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { checkListing, checkStore, FLAGGED_PATTERNS } = require('../src/services/moderationService.js');

// One pattern with an obvious plain-text match: the "casino" alternative of the
// first FLAGGED_PATTERNS entry.
const PHRASE = 'casino';
const PHRASE_PATTERN = 'gambling|betting|casino';

// a→4, e→3, i→1, o→0 — the look-alike digits the service maps back.
const digitize = (s) => s.replace(/[aeio]/g, (c) => ({ a: '4', e: '3', i: '1', o: '0' }[c]));
const spaceOut = (s) => s.split('').join(' ');
const zeroWidth = (s) => s.split('').join('\u200B');
const fullWidth = (s) => s.replace(/[!-~]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0xFEE0));

const CLEAN = [
  'Samsung Galaxy A12 64GB good condition KSh 12000',
  'Used mattress 5x6 hostel pickup',
  'Table and 4 chairs 3500 negotiable',
  'iPhone 11 128GB battery 87 percent',
  'Calculus textbook 3rd edition',
  'Bicycle 26 inch 7 speed',
  'Room 14B hostel key swap',
  'Rice 50kg bag 4800',
  'Laptop HP 840 G3 i5 8GB 256GB SSD',
  'Wedding dress size 10 worn once',
  'Maize flour 2kg 130 shillings',
  'Phone 0700 000 000 ask for Jane',
];

describe('moderationService — evasion matching (Phase 8b Step 2)', () => {
  it('the control phrase is flagged (plain text)', () => {
    const result = checkListing({ description: PHRASE });
    expect(result.approved).toBe(false);
    expect(result.flaggedBy.map((m) => m.pattern)).toContain(PHRASE_PATTERN);
  });

  it('flags look-alike digit substitution (a→4, e→3, i→1, o→0)', () => {
    const result = checkListing({ description: digitize(PHRASE) , title: 'Clean' });
    expect(digitize(PHRASE)).not.toBe(PHRASE);
    expect(result.approved).toBe(false);
    expect(result.flaggedBy.map((m) => m.pattern)).toContain(PHRASE_PATTERN);
  });

  it('flags single-letter spacing', () => {
    const result = checkListing({ description: spaceOut(PHRASE), title: 'Clean' });
    expect(result.approved).toBe(false);
    expect(result.flaggedBy.map((m) => m.pattern)).toContain(PHRASE_PATTERN);
  });

  it('flags zero-width spaces between letters', () => {
    const result = checkListing({ description: zeroWidth(PHRASE), title: 'Clean' });
    expect(result.approved).toBe(false);
    expect(result.flaggedBy.map((m) => m.pattern)).toContain(PHRASE_PATTERN);
  });

  it('flags full-width Unicode letters (NFKD form)', () => {
    const result = checkListing({ description: fullWidth(PHRASE), title: 'Clean' });
    expect(result.approved).toBe(false);
    expect(result.flaggedBy.map((m) => m.pattern)).toContain(PHRASE_PATTERN);
  });

  it('flags the same four evasions through checkStore (store description)', () => {
    for (const evasion of [digitize(PHRASE), spaceOut(PHRASE), zeroWidth(PHRASE), fullWidth(PHRASE)]) {
      const result = checkStore({ name: 'Clean Shop', description: evasion });
      expect(result.approved, `store description ${JSON.stringify(evasion)} must be flagged`).toBe(false);
      expect(result.flaggedBy.map((m) => m.pattern)).toContain(PHRASE_PATTERN);
    }
  });

  it('keeps all twelve clean strings approved through checkListing', () => {
    for (const text of CLEAN) {
      const result = checkListing({ description: text });
      expect(result.approved, `clean string must stay approved: ${JSON.stringify(text)}`).toBe(true);
      expect(result.flaggedBy).toEqual([]);
    }
  });

  it('keeps the result shape identical to a no-evasion result', () => {
    const baselineListing = checkListing({ title: 'A plain title with nothing flagged' });
    expect(Object.keys(checkListing({ description: PHRASE }))).toEqual(Object.keys(baselineListing));
    expect(Object.keys(checkListing({ description: CLEAN[0] }))).toEqual(Object.keys(baselineListing));
    expect(Object.keys(checkListing({ description: zeroWidth(PHRASE) }))).toEqual(Object.keys(baselineListing));

    const baselineStore = checkStore({ name: 'A plain store name' });
    expect(Object.keys(checkStore({ description: PHRASE }))).toEqual(Object.keys(baselineStore));
    expect(Object.keys(checkStore({ description: CLEAN[0] }))).toEqual(Object.keys(baselineStore));
  });

  it('does not add any pattern text (the pattern lists keep their sources)', () => {
    expect(FLAGGED_PATTERNS.map((re) => re.source)).toContain(PHRASE_PATTERN);
  });
});