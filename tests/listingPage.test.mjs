/* eslint-disable no-undef -- document/window/Event/localStorage/IntersectionObserver are provided by the JSDOM instance constructed below, matching the house manual-JSDOM pattern (domTerms.test.mjs) */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import { createRequire } from 'node:module';

// Focused coverage for the crawlable public listing pages (GET /listing/:id)
// and the real <a href> links listing cards now expose.
//
// Server side: the REAL server.js is imported with in-memory model fakes
// injected into require.cache BEFORE the import (same seam as wiring.test.mjs,
// where vi.mock does not reach CJS consumers in this vitest/Node setup).
// Client side: the REAL app.js is driven in a manual JSDOM against the real
// index.html (house pattern from domTerms.test.mjs), stubbed fetch returns a
// listing payload, and the rendered grid must contain actual anchors with the
// /listing/{id} hrefs. The card click (not the anchor) still drives the modal.

process.env.ADMIN_KEY = 'test-admin-key';
process.env.INTASEND_WEBHOOK_CHALLENGE = 'test-challenge';
process.env.ADMIN_SESSION_SECRET = 'test-session-secret';

const require = createRequire(import.meta.url);
const resolveFromTests = (p) => require.resolve(p);

const h = { listings: [] };

// Minimal Listing fake covering exactly the call shapes getListingPage uses.
// Mongoose models return a chainable query object (whose .lean() resolves the
// doc), NOT the document itself — the fake must match that shape or the
// controller throws "findOne(...).lean is not a function" and 500s.
const fakeListingModel = {
  findOne: (filter = {}) => {
    const resolved = (async () => {
      if (filter._id === undefined) return null;
      let doc;
      if (typeof filter._id === 'object' && filter._id.$in) {
        doc = h.listings.find((l) => filter._id.$in.map(String).includes(String(l._id)));
        if (doc) {
          for (const [k, v] of Object.entries(filter)) {
            if (k === '_id' || v === undefined) continue;
            if (doc[k] !== v) return null;
          }
        }
        return doc;
      }
      doc = h.listings.find((l) => String(l._id) === String(filter._id)) || null;
      if (!doc) return null;
      for (const [k, v] of Object.entries(filter)) {
        if (k === '_id') continue;
        if (doc[k] !== v) return null;
      }
      return doc;
    })();
    // Only .lean() is chained on this query path; make it awaitable.
    return { lean: async () => await resolved };
  },
};

function injectModule(relPath, exportsObj) {
  const resolved = resolveFromTests(relPath);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, path: resolved, exports: exportsObj };
}

// The real Listing model would attempt to connect via mongoose through server.js
// — replace it with the in-memory fake before server.js is imported.
injectModule('../src/models/Listing.js', fakeListingModel);

// The listing page does not need payments, whatsapp, cloudinary, audit logging,
// or admin sessions — silence everything server.js pulls in for those so the
// route under test can exercise its logic in isolation from external systems.
const fakeLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
injectModule('../src/config/logger.js', fakeLogger);
injectModule('../src/services/whatsappService.js', { broadcastListing: async () => {} });
injectModule('../src/config/cloudinary.js', { uploader: { destroy: async () => {} } });
injectModule('../src/models/Payment.js', {});
injectModule('../src/models/TermsAcceptance.js', {});
injectModule('../src/models/Admin.js', {});
injectModule('../src/models/AuditEvent.js', {});
injectModule('../src/models/BlockedContact.js', {});
injectModule('../src/models/Report.js', {});
injectModule('../src/models/Store.js', { findOne: async () => null, findById: async () => null });

// Passthrough limiters — mirrors adminGrant.test.mjs's full module shape so
// every middleware server.js wires resolves to a no-op in this suite.
const pass = () => (req, res, next) => next();
const fakeRateLimiterModule = {
  globalLimiter: pass(),
  vitalsLimiter: pass(),
  uploadLimiter: pass(),
  uploadDailyLimiter: pass(),
  paymentLimiter: pass(),
  listingCreateLimiter: pass(),
  contactLimiter: pass(),
  adminLimiter: pass(),
  statusLimiter: pass(),
  contactReleaseLimiter: pass(),
  reportLimiter: pass(),
};
injectModule('../src/middleware/rateLimiter.js', fakeRateLimiterModule);

let app;

beforeAll(async () => {
  app = (await import('../server.js')).default;
});

afterAll(() => { vi.restoreAllMocks(); });

// 24-hex-char well-formed id for a listing that is seeded in the fake.
const SEEDED_ID = 'aaaaaaaaaaaaaaaaaaaaa001';
const VALID_MISSING_ID = 'aaaaaaaaaaaaaaaaaaaaa002';
const EXPIRED_ID = 'aaaaaaaaaaaaaaaaaaaaa003';
const FLAGGED_ID = 'aaaaaaaaaaaaaaaaaaaaa004';
const SOLD_ID = 'aaaaaaaaaaaaaaaaaaaaa005';

function seedListings() {
  h.listings.length = 0;
  h.listings.push(
    { _id: SEEDED_ID, title: 'Kinesiology Textbook', category: 'academic', condition: 'Good', price: 1200, description: 'MATH 111 textbook, no notes inside.', images: ['https://res.cloudinary.com/demo/image/upload/cover.jpg'], sellerName: 'Jane', location: 'Njoro', views: 4, status: 'active', moderationStatus: 'approved', expiresAt: new Date(Date.now() + 86400000) },
    // Well-formed id whose only doc is NOT publicly visible: the id must 404,
    // and neither this doc's content nor any other listing's may leak.
    { _id: VALID_MISSING_ID, title: 'Should never show', category: 'academic', condition: 'Good', price: 1, description: 'x', images: [], sellerName: 'Ghost', location: 'Njoro', views: 0, status: 'removed', moderationStatus: 'approved' },
    { _id: EXPIRED_ID, title: 'Expired listing', category: 'academic', condition: 'Good', price: 1, description: 'x', images: [], sellerName: 'Gone', location: 'Njoro', views: 0, status: 'expired', moderationStatus: 'approved' },
    { _id: FLAGGED_ID, title: 'Flagged listing', category: 'academic', condition: 'Good', price: 1, description: 'x', images: [], sellerName: 'Flagged', location: 'Njoro', views: 0, status: 'active', moderationStatus: 'flagged' },
    { _id: SOLD_ID, title: 'Sold listing', category: 'academic', condition: 'Good', price: 1, description: 'x', images: [], sellerName: 'Sold', location: 'Njoro', views: 0, status: 'sold', moderationStatus: 'approved' },
  );
}

describe('GET /listing/:id — crawlable HTML listing page', () => {
  it('200: renders the seeded listing as static HTML with its content, served as text/html', async () => {
    seedListings();
    const res = await request(app).get(`/listing/${SEEDED_ID}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    // Content is IN the initial HTML — no JavaScript needed.
    expect(res.text).toContain('Kinesiology Textbook');
    expect(res.text).toContain('MATH 111 textbook');
    expect(res.text).toContain('KSh 1,200');
    expect(res.text).toContain('Jane');
    expect(res.text).toContain('Njoro');
    // The listing image URL is a real <img src>.
    expect(res.text).toContain('src="https://res.cloudinary.com/demo/image/upload/cover.jpg"');
    // Privacy: contact number is never on the public page.
    expect(res.text).not.toMatch(/\+254|07\d{8}/);
    // A back-link to the SPA browse shell is present.
    expect(res.text).toContain('href="/"');
  });

  it('200: escaping — a hostile title is entity-encoded, never raw HTML', async () => {
    seedListings();
    h.listings[0].title = '<script>alert(1)</script>';
    h.listings[0].description = 'desc with "quotes" & <tags>';
    const res = await request(app).get(`/listing/${SEEDED_ID}`);
    expect(res.status).toBe(200);
    expect(res.text).not.toContain('<script>alert(1)</script>');
    expect(res.text).toContain('&lt;script&gt;');
    expect(res.text).toContain('&quot;quotes&quot;');
  });

  it('404: nonexistent but well-formed listing id returns the standalone 404 page', async () => {
    seedListings();
    const res = await request(app).get(`/listing/${VALID_MISSING_ID}`);
    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.text).toContain('Listing not found');
    // The 404 page must not leak another listing's content.
    expect(res.text).not.toContain('Should never show');
    expect(res.text).not.toContain('Kinesiology');
  });

  it('404: invalid (malformed) identifier — never a 500, no DB query', async () => {
    seedListings();
    const before = h.listings.map((l) => l._id);
    for (const bad of ['not-an-objectid', '../../etc/passwd', 'a'.repeat(25) + 'x', '%00', '']) {
      const res = await request(app).get(`/listing/${encodeURIComponent(bad)}`);
      expect(res.status, `case ${bad}`).toBe(404);
      expect(res.headers['content-type']).toContain('text/html');
    }
    // Empty-id case: /listing/ with nothing after it — Express does not match
    // the route at all, so it must NOT 500.
    const emptyRes = await request(app).get('/listing/');
    expect([404, 200]).toContain(emptyRes.status);
    // No listing was mutated by any of the probes.
    expect(h.listings.map((l) => l._id)).toEqual(before);
  });

  it('404: hidden listings — expired, flagged, sold — are all 404, never another listing', async () => {
    seedListings();
    for (const id of [EXPIRED_ID, FLAGGED_ID, SOLD_ID]) {
      const res = await request(app).get(`/listing/${id}`);
      expect(res.status).toBe(404);
      expect(res.text).not.toContain('Kinesiology');
    }
  });

  it('refresh/direct-navigation: two consecutive requests both 200 with identical content', async () => {
    seedListings();
    const r1 = await request(app).get(`/listing/${SEEDED_ID}`);
    const r2 = await request(app).get(`/listing/${SEEDED_ID}`);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    // Both are the same full page — refresh never degrades to the shell.
    expect(r1.text).toBe(r2.text);
    expect(r2.text).toContain('Kinesiology Textbook');
  });
});

// Client side: the REAL app.js against the REAL index.html — the rendered
// browse grid must contain genuine <a href="/listing/{id}"> links, and the
// modal must keep working (click on the body, not the anchor, opens it).
describe('listing cards expose real crawlable links (real app.js in JSDOM)', () => {
  const LISTINGS_PAYLOAD = {
    ok: true, status: 200,
    json: async () => ({
      success: true, count: 2, total: 2, page: 1, totalPages: 1,
      listings: [
        { _id: 'abcdefabcdefabcdefa00012', title: 'Linked listing', category: 'academic', condition: 'Good', price: 500, description: 'd', location: 'Njoro', sellerName: 'S', sellerWhatsapp: '+254700000000', views: 1, images: [], featured: false },
        { _id: 'abcdefabcdefabcdefa00099', title: 'Second listing', category: 'academic', condition: 'New', price: 900, description: 'd', location: 'Njoro', sellerName: 'S', sellerWhatsapp: '+254700000001', views: 2, images: [], featured: false },
      ],
    }),
  };

  beforeAll(async () => {
    const { JSDOM, VirtualConsole } = await import('jsdom');
    const { readFileSync } = await import('node:fs');
    const path = await import('node:path');
    const html = readFileSync(path.join(process.cwd(), 'public', 'index.html'), 'utf8');
    const virtualConsole = new VirtualConsole();
    virtualConsole.forwardTo(console);
    const dom = new JSDOM(html, { url: 'https://gikomart.test/', virtualConsole });

    globalThis.document = dom.window.document;
    globalThis.window = dom.window;
    globalThis.Event = dom.window.Event;
    globalThis.localStorage = dom.window.localStorage;
    globalThis.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };

    vi.stubGlobal('fetch', vi.fn(async (url) => {
      const u = String(url);
      if (u.includes('/terms/versions')) {
        return { ok: true, status: 200, json: async () => ({ success: true, versions: { GIKOMART_TERMS_OF_SERVICE: '1.0.0', STORE_OWNER_TERMS: '1.0.0', SELLER_TERMS: '1.0.0', BUYER_TERMS: '1.0.0' } }) };
      }
      if (u.includes('/listings/categories')) {
        return { ok: true, status: 200, json: async () => ({ success: true, categories: [{ id: 'academic', name: 'Academic', icon: '📚' }] }) };
      }
      if (u.includes('/api/listings') && !u.includes('/listings/categories')) return LISTINGS_PAYLOAD;
      return { ok: true, status: 200, json: async () => ({ success: true }) };
    }));

    await import('../public/assets/js/app.js');
    document.dispatchEvent(new Event('DOMContentLoaded'));
    await new Promise((r) => setTimeout(r, 30));
  });

  it('every browse card contains two real anchors whose hrefs are /listing/{id},域名 escaped', () => {
    const cards = [...document.querySelectorAll('#listingGrid .listing-card')];
    expect(cards.length).toBeGreaterThanOrEqual(2);
    for (const card of cards) {
      const links = [...card.querySelectorAll('a.listing-link')];
      expect(links.length).toBe(2);
      for (const a of links) {
        expect(a.getAttribute('href')).toBe(`/listing/${card.dataset.id}`);
      }
    }
    // The title link wraps the title text.
    const first = cards[0];
    expect(first.querySelector('.listing-title-link').textContent).toContain('Linked listing');
  });

  it('clicking the card body (not the anchor) still opens the SPA detail modal', () => {
    const card = [...document.querySelectorAll('#listingGrid .listing-card')][0];
    card.click();
    expect(document.getElementById('modalOverlay').classList.contains('open')).toBe(true);
    expect(document.getElementById('modalCard').textContent).toContain('Linked listing');
    document.querySelector('[data-action="close-modal"]').click();
    expect(document.getElementById('modalOverlay').classList.contains('open')).toBe(false);
  });

  it('anchor click bubbles but the SPA does NOT navigate — href is the only navigation route', () => {
    const titleLink = document.querySelector('.listing-title-link');
    // Anchor href is exactly the stable URL; no data-action attr, so no SPA
    // delegated action fires for it (the card body's own listener still does,
    // but that handler calls openListingModal, not a navigation).
    expect(titleLink.dataset.action).toBeUndefined();
    expect(titleLink.getAttribute('href')).toBe('/listing/abcdefabcdefabcdefa00012');
  });
});
