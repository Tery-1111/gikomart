/* eslint-disable no-undef -- document/window/localStorage/Event/HTMLElement come from the JSDOM instance constructed below, matching the existing journeyFriction/domTerms house harness */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';

// BUYER JOURNEY — one chained regression test through the REAL app.js:
//   load browse → click a real category pill → the Store-associated listing
//   renders from the fetch stub (its Store badge is built by production
//   listingCardHTML from store_name/store_slug — no synthetic markup) →
//   click the card → the listing modal opens showing the listing → close it →
//   click the REAL [data-action="open-store-page"] badge (stop-propagation
//   keeps the card modal shut) → the public Store page becomes active and
//   identifies the store.
// Harness copied from tests/journeyFriction.test.mjs (manual JSDOM on the node
// environment, real public/index.html, app.js imported after globals wired).

let listingsResponse = null;
const calls = [];
const jsonResponse = (body) => ({ ok: true, status: 200, json: async () => body });
const listingsOk = (listings) => ({ success: true, listings, total: listings.length, page: 1, totalPages: 1 });

const LISTING = {
  _id: 'l-s1',
  title: 'Kettle',
  category: 'electronics',
  condition: 'New',
  price: 800,
  location: 'Njoro',
  sellerName: 'S',
  description: 'd',
  images: [],
  store_name: 'Rig Store',
  store_slug: 'rig-store',
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
  globalThis.FormData = dom.window.FormData;
  globalThis.File = dom.window.File;
  globalThis.FileReader = dom.window.FileReader;
  // jsdom has no layout engine; these are interaction-level checks (same
  // concession the journeyFriction harness makes).
  dom.window.Element.prototype.getClientRects = function () { return [{}]; };

  vi.stubGlobal('fetch', vi.fn(async (url, options = {}) => {
    const u = String(url);
    calls.push({ url: u, options });
    if (u.includes('/terms/versions')) {
      return jsonResponse({ success: true, versions: { GIKOMART_TERMS_OF_SERVICE: '1.0.0', STORE_OWNER_TERMS: '1.0.0', SELLER_TERMS: '1.0.0', BUYER_TERMS: '1.0.0' } });
    }
    if (u.includes('/support-contact')) return jsonResponse({ success: true, support: { phoneLocal: '0776000000' } });
    if (u.includes('/listings/categories')) {
      return jsonResponse({ success: true, categories: [{ id: 'electronics', name: 'Electronics', icon: '📱' }] });
    }
    // The public Store lookup MUST be matched before the generic /listings
    // catch-all (the slug route is a distinct endpoint).
    if (u.includes('/stores/slug/rig-store')) {
      return jsonResponse({
        success: true,
        store: { _id: 'sto-pub', name: 'Rig Store', slug: 'rig-store', category: 'Electronics' },
        listingCount: 1,
      });
    }
    if (u.includes('/stores/')) return jsonResponse({ success: true });
    if (u.includes('/listings')) return listingsResponse || jsonResponse(listingsOk([]));
    return jsonResponse({ success: true });
  }));

  await import('../public/assets/js/app.js');
  document.dispatchEvent(new Event('DOMContentLoaded'));
  await new Promise((r) => setTimeout(r, 120));
});

const wait = (ms = 10) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred, tries = 200) {
  for (let i = 0; i < tries; i += 1) {
    if (pred()) return true;
    await wait(5);
  }
  return pred();
}

beforeEach(() => {
  calls.length = 0;
  listingsResponse = jsonResponse(listingsOk([LISTING]));
  localStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('buyer journey — pill filter → listing modal → real Store badge → public Store', () => {
  it('chains category selection, listing modal, and the rendered store badge through the real UI', async () => {
    // ── Step 1: load and filter ────────────────────────────────────────────
    await waitFor(() => document.querySelector('#catPills .cat-pill'), 'category pills render');
    const pills = [...document.querySelectorAll('#catPills .cat-pill')];
    const electronicsPill = pills.find((p) => p.textContent.includes('Electronics'));
    expect(electronicsPill, 'the Electronics category pill must exist').toBeTruthy();

    electronicsPill.click();
    // The real filter path: filterByCategory sets browseState and re-fetches.
    await waitFor(() => calls.some((c) => c.url.includes('category=electronics')));
    const filtered = calls.filter((c) => c.url.includes('/listings') && c.url.includes('category=electronics'));
    expect(filtered.length).toBeGreaterThanOrEqual(1);
    // Wait for the actual filtered listing to be rendered by loadListings.
    await waitFor(() => [...document.querySelectorAll('#listingGrid .listing-card')].some((c) => c.dataset.id === 'l-s1'));

    // ── Step 2: open the listing ───────────────────────────────────────────
    const card = [...document.querySelectorAll('#listingGrid .listing-card')].find((c) => c.dataset.id === 'l-s1');
    expect(card, 'the Store-associated listing card must render').toBeTruthy();
    card.click();
    await waitFor(() => document.getElementById('modalOverlay').classList.contains('open'));
    expect(document.getElementById('modalOverlay').classList.contains('open')).toBe(true);
    expect(document.getElementById('modalCard').textContent).toContain('Kettle');

    // ── Step 3: close, then open the Store from the REAL badge ─────────────
    const close = document.querySelector('#modalCard [data-action="close-modal"], #modalCard .modal-close');
    expect(close, 'the listing modal must expose its close control').toBeTruthy();
    close.click();
    await waitFor(() => !document.getElementById('modalOverlay').classList.contains('open'));

    // Production listingCardHTML builds this badge from store_name/store_slug:
    // no synthetic injection anywhere in this test.
    const badge = card.querySelector('[data-action="open-store-page"]');
    expect(badge, 'the real store badge rendered by listingCardHTML').toBeTruthy();
    expect(badge.dataset.slug).toBe('rig-store');
    expect(badge.textContent).toContain('Rig Store');

    badge.click();
    // The badge carries data-stop="1": the card's own click binding must NOT
    // also re-open the listing modal behind the store view.
    await waitFor(() => document.getElementById('view-storepage').classList.contains('active'));
    expect(document.getElementById('view-storepage').classList.contains('active')).toBe(true);
    expect(document.getElementById('modalOverlay').classList.contains('open')).toBe(false);

    await waitFor(() => document.getElementById('storePageContent') && document.getElementById('storePageContent').textContent.includes('Rig Store'));
    expect(document.getElementById('storePageContent').textContent).toContain('Rig Store');
  });
});
