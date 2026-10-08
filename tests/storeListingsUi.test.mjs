// FRONTEND/BACKEND CONTRACT — store-included listing UI (§20 of the edge plan).
// Drives the REAL app.js against the REAL public/index.html in a manual JSDOM
// (the house pattern from tests/domTerms.test.mjs / storeSave.test.mjs), with
// fetch stubbed. Verifies the seller-facing contract of the bundled entitlement:
// capacity display is server-derived, the included flow never sends a payment
// request, manual attach is not required, and server rejection is rendered
// cleanly without corrupting the displayed capacity.

/* eslint-disable no-undef -- document/localStorage/Event are provided by the JSDOM instance constructed below */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

// Canonical listing-category metadata built FROM the real backend config — the
// payload /api/listings/categories serves — so the UI contract cannot drift.
const { LISTING_CATEGORIES } = await import('../src/config/listingOptions.js');
const canonicalListingCategories = LISTING_CATEGORIES.map(({ id, name, icon, legacyNames }) => ({ id, name, icon, legacyNames }));

const STORE = {
  _id: 'sto-ui',
  name: 'UI Contract Store',
  slug: 'ui-contract-store',
  plan: 'starter_weekly',
  status: 'active',
  category: 'Electronics',
  listing_limit: 5,
  expires_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
};

const calls = [];
let storeListingResponse = { ok: true, status: 201, body: { success: true, message: 'published', listing: { _id: 'lst-ui-1' } } };

const jsonResponse = (body) => ({ ok: true, status: 200, json: async () => body });

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
  globalThis.FormData = dom.window.FormData;
  globalThis.File = dom.window.File;
  globalThis.FileReader = dom.window.FileReader;

  vi.stubGlobal('fetch', vi.fn(async (url, options = {}) => {
    const u = String(url);
    calls.push({ url: u, method: options.method || 'GET', options });
    if (u.includes('/terms/versions')) {
      return jsonResponse({
        success: true,
        versions: { GIKOMART_TERMS_OF_SERVICE: '1.0.0', STORE_OWNER_TERMS: '1.0.0', SELLER_TERMS: '1.0.0', BUYER_TERMS: '1.0.0' },
      });
    }
    if (u.includes(`/stores/${STORE._id}/listings`)) {
      return { ok: storeListingResponse.ok, status: storeListingResponse.status, json: async () => storeListingResponse.body };
    }
    if (u.includes(`/stores/${STORE._id}`)) {
      // Server-derived capacity: 3 active of 5.
      return jsonResponse({ success: true, store: STORE, listingCount: 3 });
    }
    // Canonical category metadata from the real backend config (drift guard).
    if (u.includes('/listings/categories')) {
      return jsonResponse({ success: true, categories: canonicalListingCategories });
    }
    if (u.includes('/listings')) return jsonResponse({ success: true, listings: [] });
    return jsonResponse({ success: true });
  }));

  // The seller already owns this store: seed the credential app.js reads.
  localStorage.setItem('gikomart_storeToken:sto-ui', 'ui-store-token');
  await import('../public/assets/js/app.js');
  document.dispatchEvent(new Event('DOMContentLoaded'));
  await new Promise((r) => setTimeout(r, 25));
});

beforeEach(() => {
  calls.length = 0;
  storeListingResponse = { ok: true, status: 201, body: { success: true, message: 'published', listing: { _id: 'lst-ui-1' } } };
});

async function openMyStore() {
  document.querySelector('.nav-link[data-view="mystore"]').click();
  await new Promise((r) => setTimeout(r, 10));
}

const wait = (ms = 10) => new Promise((r) => setTimeout(r, ms));

describe('store dashboard capacity display (server-derived)', () => {
  it('renders "3 / 5 used (2 remaining)" from the server listingCount, not a client counter', async () => {
    await openMyStore();
    const text = document.getElementById('mystoreContent').textContent;
    expect(text).toContain('3 / 5');
    expect(text).toContain('2 remaining');
  });

  it('exposes the + Add Listing action carrying the store id and remaining capacity', async () => {
    await openMyStore();
    const btn = document.querySelector('[data-action="add-listing"]');
    expect(btn).toBeTruthy();
    expect(btn.textContent).toContain('+ Add Listing');
    expect(btn.dataset.storeId).toBe(STORE._id);
    expect(btn.dataset.available).toBe('2');
  });
});

describe('included-listing publish flow (no payment, no attach)', () => {
  it('opens the sell form in store context: no package picker, explicit no-charge note and label', async () => {
    await openMyStore();
    document.querySelector('[data-action="add-listing"]').click();
    expect(document.getElementById('view-sell').classList.contains('active')).toBe(true);
    const pkg = document.getElementById('packageSection');
    expect(pkg.querySelector('.boost-option')).toBeNull(); // KES package picker hidden
    expect(pkg.textContent).toContain('Covered by your store plan');
    expect(pkg.textContent).toContain('2 listings remaining');
    expect(document.getElementById('submitBtn').textContent).toContain('no charge');
  });

  it('submits to POST /api/stores/:id/listings with the store token and NEVER to the payment endpoint', async () => {
    await openMyStore();
    document.querySelector('[data-action="add-listing"]').click();
    document.getElementById('f-title').value = 'UI Contract Camera';
    document.getElementById('f-category').value = 'electronics';
    document.getElementById('f-condition').value = 'Good';
    document.getElementById('f-price').value = '4000';
    document.getElementById('f-description').value = 'Works perfectly.';
    document.getElementById('f-seller').value = 'Jane';
    document.getElementById('f-whatsapp').value = '0711111111';
    document.getElementById('sellForm').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await wait(30);
    const posts = calls.filter((c) => c.method === 'POST');
    expect(posts).toHaveLength(1);
    expect(posts[0].url).toContain(`/api/stores/${STORE._id}/listings`);
    expect(posts[0].options.headers['X-Store-Owner-Token']).toBe('ui-store-token');
    // Payment isolation at the UI layer.
    expect(calls.some((c) => c.url.includes('/payments/'))).toBe(false);
    // Success is rendered.
    expect(document.querySelector('#view-sell .form-status').textContent).toContain('Published in your store');
  });

  it('a SERVER REJECTION is rendered cleanly and never decrements the displayed capacity', async () => {
    storeListingResponse = { ok: false, status: 409, body: { success: false, error: 'Store listing limit reached (5). Remove a listing or use a standalone listing package.' } };
    await openMyStore();
    document.querySelector('[data-action="add-listing"]').click();
    document.getElementById('f-title').value = 'Overflow item';
    document.getElementById('f-category').value = 'electronics';
    document.getElementById('f-condition').value = 'Good';
    document.getElementById('f-price').value = '10';
    document.getElementById('f-description').value = 'Should be rejected.';
    document.getElementById('f-seller').value = 'Jane';
    document.getElementById('f-whatsapp').value = '0711111111';
    document.getElementById('sellForm').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await wait(30);
    expect(document.querySelector('#view-sell .form-status').textContent).toContain('Store listing limit reached');
    // The context note still shows the SERVER-derived remaining count (2) —
    // a failed publish must not consume a slot in the UI.
    expect(document.getElementById('packageSection').textContent).toContain('2 listings remaining');
  });
});

describe('store-context reset', () => {
  it('manual navigation resets the context: the standard KES package picker is restored', async () => {
    await openMyStore();
    document.querySelector('[data-action="add-listing"]').click();
    expect(document.getElementById('packageSection').querySelector('.boost-option')).toBeNull();
    // Navigate away to browse, then manually back into sell.
    document.querySelector('.nav-link[data-view="browse"]').click();
    document.querySelector('.nav-link[data-view="sell"]').click();
    expect(document.getElementById('packageSection').querySelector('.boost-option')).toBeTruthy();
    expect(document.getElementById('packageSection').textContent).not.toContain('Covered by your store plan');
  });
});
