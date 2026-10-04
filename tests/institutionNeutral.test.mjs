// Regression guard: GikoMart must stay institution-neutral (docs/DECISIONS.md 32).
//
// Deliberately GENERIC — it checks for institution *vocabulary* and academic
// domains rather than one hardcoded name, so the guard itself contains no
// institution name. To additionally pin a specific legacy name, set
// LEGACY_INSTITUTION_TOKEN; the last test then fails if that name reappears.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const root = process.cwd();
const read = (rel) => readFileSync(path.join(root, rel), 'utf8');
const require = createRequire(import.meta.url);

// Institution words that should never describe the product. "campus" is
// intentionally allowed (it is generic marketplace language).
const INSTITUTION_WORDS = /\b(?:University|College|Polytechnic|Institute|Faculty|Seminary|Academy)\b/i;
// Academic top-level domains (e.g. *.ac.ke) or bare "ac.ke".
const ACADEMIC_DOMAIN = /(?:^|[^a-z0-9])ac\.ke\b/i;

const LEGAL_PAGES = [
  'public/legal/terms-of-service.html',
  'public/legal/privacy-policy.html',
  'public/legal/buyer-terms.html',
  'public/legal/seller-terms.html',
  'public/legal/store-owner-terms.html',
  'public/legal/prohibited-items.html',
  'public/legal/data-requests.html',
];

const PAGES = ['public/index.html', 'public/ui-preview/index.html', ...LEGAL_PAGES];

const CAMPUS_TAG = /<span class="campus-tag">📍 ([^<]+)<\/span>/;

// Server-side sources whose user-facing text must stay institution-neutral:
// the central error handler, the WhatsApp broadcast, the content moderation
// service, and every controller (enumerated so new ones are covered too).
const CONTROLLER_DIR = 'src/controllers';
const SERVER_SOURCES = [
  'src/middleware/errorHandler.js',
  'src/services/whatsappService.js',
  'src/services/moderationService.js',
  ...readdirSync(path.join(root, CONTROLLER_DIR))
    .filter((f) => f.endsWith('.js'))
    .sort()
    .map((f) => `${CONTROLLER_DIR}/${f}`),
];

describe('institution neutrality', () => {
  it('homepage and legal pages name no institution and carry the neutral location tag', () => {
    for (const rel of ['public/index.html', ...LEGAL_PAGES]) {
      const html = read(rel);
      expect(html, rel).not.toMatch(INSTITUTION_WORDS);
      expect(html, rel).not.toMatch(ACADEMIC_DOMAIN);
      const tag = html.match(CAMPUS_TAG);
      expect(tag, `${rel} should carry a campus tag`).not.toBeNull();
      expect(tag[1], `${rel} campus tag`).toBe('Njoro');
    }
  });

  it('the UI preview page names no institution', () => {
    const html = read('public/ui-preview/index.html');
    expect(html).not.toMatch(INSTITUTION_WORDS);
    expect(html).not.toMatch(ACADEMIC_DOMAIN);
  });

  it('package metadata names no institution', () => {
    const pkg = JSON.parse(read('package.json'));
    const text = [pkg.description, ...(pkg.keywords || [])].join(' ');
    expect(text).not.toMatch(INSTITUTION_WORDS);
    expect(text).not.toMatch(ACADEMIC_DOMAIN);
  });

  it('new Store and Listing records get the neutral location default', () => {
    expect(read('src/models/Store.js')).toMatch(/campus:\s*\{[^}]*default:\s*'Njoro'/);
    expect(read('src/models/Listing.js')).toMatch(/location:\s*\{[^}]*default:\s*'Njoro'/);
    expect(read('src/controllers/paymentController.js'))
      .toMatch(/campus:\s*payment\.storeData\.campus\s*\|\|\s*'Njoro'/);
  });

  it('no scanned page or default references an academic domain', () => {
    for (const rel of [...PAGES, 'src/models/Store.js', 'src/models/Listing.js']) {
      expect(read(rel), rel).not.toMatch(ACADEMIC_DOMAIN);
    }
  });

  it('controllers, error handler and services name no institution', () => {
    expect(SERVER_SOURCES).toContain(`${CONTROLLER_DIR}/paymentController.js`);
    for (const rel of SERVER_SOURCES) {
      const src = read(rel);
      expect(src, rel).not.toMatch(INSTITUTION_WORDS);
      expect(src, rel).not.toMatch(ACADEMIC_DOMAIN);
    }
  });

  it('the WhatsApp broadcast message names no institution', () => {
    const { formatMessage } = require('../src/services/whatsappService.js');
    const message = formatMessage({
      title: 'Calculus Textbook',
      price: 1500,
      category: 'Books',
      condition: 'Used',
      description: 'Well-kept textbook, collection at the local pickup point.',
      location: 'Njoro',
      sellerName: 'Amina',
      sellerWhatsapp: '+254700000000',
    });
    expect(message).toMatch(/GikoMart/);
    expect(message).not.toMatch(INSTITUTION_WORDS);
    expect(message).not.toMatch(ACADEMIC_DOMAIN);
  });

  it('the moderation service carries no institution terms', () => {
    const { checkListing, checkStore, FLAGGED_PATTERNS, SCAM_PATTERNS } =
      require('../src/services/moderationService.js');
    const patternText = [...FLAGGED_PATTERNS, ...SCAM_PATTERNS].map((re) => re.source).join(' ');
    expect(patternText).not.toMatch(INSTITUTION_WORDS);
    expect(patternText).not.toMatch(ACADEMIC_DOMAIN);
    // Neutral local content is approved — no institution rule sneaks in.
    expect(checkListing({ title: 'Bicycle', description: 'Good condition', location: 'Njoro' }).approved)
      .toBe(true);
    expect(checkStore({ name: 'Corner Shop', location: 'Njoro' }).approved).toBe(true);
  });

  it.runIf(process.env.LEGACY_INSTITUTION_TOKEN)(
    'the configured legacy name does not appear in any scanned page',
    () => {
      const token = process.env.LEGACY_INSTITUTION_TOKEN;
      const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const pattern = new RegExp(escaped, 'i');
      for (const rel of [...PAGES, ...SERVER_SOURCES]) {
        expect(read(rel), rel).not.toMatch(pattern);
      }
    }
  );
});
