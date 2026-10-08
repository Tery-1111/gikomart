import { describe, it, expect } from 'vitest';
import request from 'supertest';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.resolve(here, '../public');

const read = (rel) => fs.readFileSync(path.join(PUBLIC, rel), 'utf8');
// Hash the LF-normalized content so the assertion holds whichever line ending a
// checkout produces (the repository stores these files as CRLF in the worktree).
const sha = (text) => crypto.createHash('sha256').update(text.replace(/\r\n/g, '\n')).digest('hex');

const headings = (html) => [...html.matchAll(/<h2>([^<]+)<\/h2>/g)].map((m) => m[1]);

// Serve public/ exactly as server.js does (express.static). This keeps the
// suite free of the full app and any database.
const app = express();
app.use(express.static(PUBLIC));

const NEW_PAGES = ['legal/privacy-policy.html', 'legal/prohibited-items.html', 'legal/data-requests.html'];

// Only [EFFECTIVE_DATE] may remain: the four contact/identity placeholders
// ([OPERATOR_NAME], [OPERATOR_ADDRESS], [SUPPORT_EMAIL], [SUPPORT_WHATSAPP])
// were resolved to the approved admin support contact — enforced below and in
// tests/supportContact.test.mjs.

// Hashes of the four versioned legal pages as of the institution-neutral baseline
// (updated when the pages' institution-specific branding/scope wording was removed,
// and again when the pages' heads were technically updated in the Phase 1
// frontend batch: inline SVG favicon added, Google Fonts links removed in favor
// of self-hosted fonts — legal text itself unchanged).
const EXISTING_LEGAL_HASHES = {
  // terms-of-service re-pinned when the [OPERATOR_ADDRESS] placeholder was
  // resolved to the approved broad locality "Njoro, Nakuru County, Kenya"
  // (admin support-contact implementation; legal wording otherwise unchanged).
  'legal/terms-of-service.html': 'a940b9a52d6b0174d773e2defbdbe9285070d0eafeac0bde8873ab78ab2669e1',
  'legal/store-owner-terms.html': '0f27320a208ba93e846866add862e6091c4e5b3e3d633488774fe3cbf4b31930',
  'legal/seller-terms.html': 'b0a557faaae841ba745f0f5bdf3fdc52a3bb721eea1962d49aeeafc9de8978a0',
  'legal/buyer-terms.html': 'dc9cc60cf16234617a4cb01ebc9802b0ab3cf5ac40e35f46b94da19a2cf801d1',
};

describe('New legal pages are served and well-formed', () => {
  for (const rel of NEW_PAGES) {
    it(`${rel} is served 200 as HTML with a title and an h1`, async () => {
      const res = await request(app).get(`/${rel}`);
      expect(res.status).toBe(200);
      expect(String(res.headers['content-type'])).toMatch(/text\/html/);

      const html = read(rel);
      expect(html).toMatch(/<title>[^<]+<\/title>/);
      expect(html).toMatch(/<h1>[^<]+<\/h1>/);
    });
  }

  it('contains no script tag and no inline event-handler attribute', () => {
    for (const rel of NEW_PAGES) {
      const html = read(rel);
      expect(html.includes('<script'), rel).toBe(false);
      expect(html, rel).not.toMatch(/[ \t]on[a-z]+[ \t]*=/i);
    }
  });

  it('privacy policy has the nine required headings, in order', () => {
    expect(headings(read('legal/privacy-policy.html'))).toEqual([
      '1. Who we are',
      '2. What we collect',
      '3. How we use it',
      '4. Who we share it with',
      '5. Storage in your browser and analytics',
      '6. How long we keep data',
      '7. Your rights',
      '8. Contact and complaints',
      '9. Changes to this policy',
    ]);
  });

  it('prohibited items has its four required headings, in order', () => {
    expect(headings(read('legal/prohibited-items.html'))).toEqual([
      '1. What you may not sell or post',
      '2. What happens to listings that break these rules',
      '3. How to report a listing or store',
      '4. Changes to this page',
    ]);
  });

  it('data requests has its six required headings, in order', () => {
    expect(headings(read('legal/data-requests.html'))).toEqual([
      '1. Who can make a request',
      '2. What you can ask for',
      '3. How to make a request',
      '4. What we need from you',
      '5. What happens next',
      '6. What we cannot erase and why',
    ]);
  });

  it('privacy policy cites the Data Protection Act, 2019', () => {
    expect(read('legal/privacy-policy.html')).toContain('Data Protection Act, 2019');
  });

  it('uses no contact or operator placeholders; only [EFFECTIVE_DATE] may remain', () => {
    // The support-contact ([SUPPORT_EMAIL]/[SUPPORT_WHATSAPP]) and operator
    // identity ([OPERATOR_NAME]/[OPERATOR_ADDRESS]) placeholders were resolved
    // to the approved admin support contact (WhatsApp 0776844298 via the
    // homepage footer; operator "GikoMart, Njoro, Nakuru County, Kenya").
    // [EFFECTIVE_DATE] is a versioning marker, not a contact, and remains.
    const found = new Set();
    for (const rel of NEW_PAGES) {
      for (const match of read(rel).matchAll(/\[[A-Z][A-Z_]+\]/g)) found.add(match[0]);
    }
    expect([...found].sort()).toEqual(['[EFFECTIVE_DATE]']);
  });

  it('contains no Cloudflare reference, no 64-hex string and no unexpected 9+ digit run', () => {
    // The approved support-contact number is deliberately exempted: its local
    // form (0776844298) and international wa.me form (254776844298) are the
    // ONLY permitted 9+ digit runs. Every other long digit run remains a
    // failure, so accidental leakage of secrets/hashes/IDs stays blocked.
    const APPROVED_CONTACT_DIGIT_RUNS = ['0776844298', '254776844298'];
    const scrub = (text) => text.replace(new RegExp(APPROVED_CONTACT_DIGIT_RUNS.join('|'), 'g'), '');
    for (const rel of NEW_PAGES) {
      const html = read(rel);
      expect(html.toLowerCase(), rel).not.toContain('cloudflare');
      expect(html, rel).not.toMatch(/[0-9a-f]{64}/);
      expect(scrub(html), rel).not.toMatch(/[0-9]{9,}/);
    }
  });

  it('index.html links the three new legal pages', () => {
    const html = read('index.html');
    expect(html).toContain('href="/legal/privacy-policy.html"');
    expect(html).toContain('href="/legal/prohibited-items.html"');
    expect(html).toContain('href="/legal/data-requests.html"');
  });

  it('the four existing legal pages are unchanged', () => {
    for (const [rel, expected] of Object.entries(EXISTING_LEGAL_HASHES)) {
      expect(sha(read(rel)), rel).toBe(expected);
    }
  });
});
