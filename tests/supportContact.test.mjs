// Admin/support contact contract (src/config/supportContact.js).
//
// Pins the approved support-contact surfaces: the homepage footer is the single
// public WhatsApp support placement, the email must never appear on any public
// surface, the legal pages must carry no unresolved contact/identity
// placeholders, and seller-contact mechanisms are distinct from this config.
// Companion to tests/legalPages.test.mjs (page structure/hashes) and
// tests/prohibitedReport.test.mjs (report routing wording).
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const SUPPORT_CONTACT = require('../src/config/supportContact.js');

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => fs.readFileSync(path.resolve(here, '..', rel), 'utf8');

describe('supportContact config — single source of truth', () => {
  it('carries the exact approved contact values', () => {
    expect(SUPPORT_CONTACT.supportPhoneLocal).toBe('0776844298');
    expect(SUPPORT_CONTACT.supportPhoneInternational).toBe('254776844298');
    expect(SUPPORT_CONTACT.supportEmail).toBe('trendypulsee925@gmail.com');
    expect(SUPPORT_CONTACT.operatorName).toBe('GikoMart');
    expect(SUPPORT_CONTACT.operatorLocation).toBe('Njoro, Nakuru County, Kenya');
  });

  it('is frozen so callers cannot mutate the shared contract', () => {
    expect(Object.isFrozen(SUPPORT_CONTACT)).toBe(true);
  });
});

describe('homepage footer — the one public support placement', () => {
  const index = read('public/index.html');

  it('links WhatsApp Support to the approved international destination', () => {
    expect(index).toContain('href="https://wa.me/254776844298"');
    expect(index).toContain('WhatsApp Support');
  });

  it('no longer carries the placeholder support number', () => {
    expect(index).not.toContain('wa.me/254700000000');
  });

  it('does NOT expose the support email', () => {
    expect(index).not.toContain(SUPPORT_CONTACT.supportEmail);
    expect(index).not.toContain('mailto:');
  });

  it('keeps the truthful broad Njoro locality', () => {
    expect(index).toContain('Njoro');
  });
});

describe('legal pages — placeholders resolved, email withheld', () => {
  const LEGAL_PAGES = [
    'public/legal/privacy-policy.html',
    'public/legal/prohibited-items.html',
    'public/legal/data-requests.html',
    'public/legal/terms-of-service.html',
    'public/legal/buyer-terms.html',
    'public/legal/seller-terms.html',
    'public/legal/store-owner-terms.html',
  ];

  it('carries the approved support WhatsApp number on the pages that name it', () => {
    for (const rel of ['public/legal/privacy-policy.html', 'public/legal/prohibited-items.html', 'public/legal/data-requests.html']) {
      expect(read(rel), rel).toContain('0776844298');
    }
  });

  it('states the approved operator identity and broad locality where the identity placeholders were', () => {
    expect(read('public/legal/privacy-policy.html')).toContain('operated by GikoMart, Njoro, Nakuru County, Kenya');
    expect(read('public/legal/terms-of-service.html')).toContain('Njoro, Nakuru County, Kenya');
  });

  it('resolves every support/identity placeholder (only [EFFECTIVE_DATE] may remain)', () => {
    for (const rel of LEGAL_PAGES) {
      const placeholders = [...new Set([...read(rel).matchAll(/\[[A-Z][A-Z_]+\]/g)].map((m) => m[0]))];
      for (const token of placeholders) {
        expect(token, rel).toBe('[EFFECTIVE_DATE]');
      }
    }
  });

  it('never exposes the support email in any legal page', () => {
    for (const rel of LEGAL_PAGES) {
      expect(read(rel), rel).not.toContain(SUPPORT_CONTACT.supportEmail);
    }
  });
});
