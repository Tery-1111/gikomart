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

const ALLOWED_PLACEHOLDERS = [
  '[OPERATOR_NAME]', '[OPERATOR_ADDRESS]', '[SUPPORT_EMAIL]', '[SUPPORT_WHATSAPP]', '[EFFECTIVE_DATE]',
];

// Hashes of the four versioned legal pages as committed on phase-5b-reports.
const EXISTING_LEGAL_HASHES = {
  'legal/terms-of-service.html': '5555f97c9d148dbfe070b4447cc75ed22fffb213b3a103cdecf984a5da2bc55b',
  'legal/store-owner-terms.html': '29820e0ea7596a45feb8cdb7a7e684591ec5266b27394729d8828c0f97731c82',
  'legal/seller-terms.html': 'ef08c02ea3d8770464845bb73abf0223ba4a7cad25cf60a5471515b04e42697e',
  'legal/buyer-terms.html': '748931bb9fdf5490613c2a17026301e9edd6e95182c0337caeec08118298dd27',
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

  it('uses only the five allowed placeholders across the three pages', () => {
    const found = new Set();
    for (const rel of NEW_PAGES) {
      for (const match of read(rel).matchAll(/\[[A-Z][A-Z_]+\]/g)) found.add(match[0]);
    }
    expect([...found].sort()).toEqual([...ALLOWED_PLACEHOLDERS].sort());
  });

  it('contains no Cloudflare reference, no 64-hex string and no 9+ digit run', () => {
    for (const rel of NEW_PAGES) {
      const html = read(rel);
      expect(html.toLowerCase(), rel).not.toContain('cloudflare');
      expect(html, rel).not.toMatch(/[0-9a-f]{64}/);
      expect(html, rel).not.toMatch(/[0-9]{9,}/);
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
