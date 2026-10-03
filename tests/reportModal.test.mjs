/* eslint-disable no-undef -- document/window/Event/KeyboardEvent/localStorage are provided by the JSDOM instance constructed below */
// Phase 8 — report modal hardening. Drives the REAL app.js against the REAL
// public/index.html DOM, with fetch stubbed. Harness copied from
// tests/domTerms.test.mjs (manual JSDOM on the node environment, globals copied
// onto globalThis, app.js imported after, DOMContentLoaded dispatched by hand).
//
// Order matters in this file: the app is driven into demo mode by making the
// INITIAL /listings fetch fail, so the demo-mode test must run first (while the
// app is still in demo mode). Every later test calls ensureNonDemo(), which
// clicks the grid retry banner to refetch real listings (a no-op once non-demo).
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

const OK_LISTINGS = {
  ok: true,
  status: 200,
  json: async () => ({
    success: true,
    listings: [
      {
        _id: 'lst-1', title: 'Normal listing', category: 'Electronics', condition: 'Good',
        price: 1000, description: 'A normal listing.', location: 'Njoro',
        sellerName: 'Seller', sellerWhatsapp: 'test-contact', views: 1, images: [], featured: false,
      },
      {
        _id: 'a"b<c', title: 'Tricky id listing', category: 'Electronics', condition: 'Good',
        price: 1000, description: 'A listing with a hostile id.', location: 'Njoro',
        sellerName: 'Seller', sellerWhatsapp: 'test-contact', views: 1, images: [], featured: false,
      },
      {
        _id: 'lst-store', title: 'Store listing', category: 'Electronics', condition: 'Good',
        price: 1000, description: 'A listing belonging to a store.', location: 'Njoro',
        sellerName: 'Seller', sellerWhatsapp: 'test-contact', views: 1, images: [], featured: false,
        store_name: 'Test Store', store_slug: 'test-store',
      },
    ],
  }),
};
// The initial fetch fails on purpose, driving the app into demo mode.
const FAIL_LISTINGS = { ok: false, status: 500, json: async () => ({ success: false }) };

let listingsResponse = FAIL_LISTINGS;
let reportResponse = { ok: true, status: 200, json: async () => ({ success: true }) };
const storeResponse = {
  ok: true,
  status: 200,
  json: async () => ({
    success: true,
    store: { _id: 'sto-1', name: 'Test Store', category: 'Retail', slug: 'test-store' },
    listingCount: 0,
  }),
};
const fetchCalls = [];

const tick = () => new Promise((r) => setTimeout(r, 0));
async function waitFor(pred, tries = 200) {
  for (let i = 0; i < tries; i += 1) {
    if (pred()) return true;
    await tick();
  }
  return pred();
}
const reportsCalls = () => fetchCalls.filter((c) => c.url.includes('/reports'));

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
  globalThis.KeyboardEvent = dom.window.KeyboardEvent;
  globalThis.localStorage = dom.window.localStorage;
  globalThis.FormData = dom.window.FormData;
  globalThis.File = dom.window.File;
  globalThis.FileReader = dom.window.FileReader;
  dom.window.open = vi.fn();

  const jsonResponse = (body) => ({ ok: true, status: 200, json: async () => body });
  vi.stubGlobal('fetch', vi.fn(async (url, options = {}) => {
    const u = String(url);
    fetchCalls.push({ url: u, options });
    if (u.includes('/terms/versions')) {
      return jsonResponse({
        success: true,
        versions: {
          GIKOMART_TERMS_OF_SERVICE: '1.0.0', STORE_OWNER_TERMS: '1.0.0',
          SELLER_TERMS: '1.0.0', BUYER_TERMS: '1.0.0',
        },
      });
    }
    if (u.includes('/reports')) return reportResponse;
    if (u.includes('/stores/slug/')) return storeResponse;
    if (u.includes('/listings')) return listingsResponse;
    return jsonResponse({ success: true });
  }));

  dom.window.addEventListener('error', (e) => console.log('WINDOW-ERROR:', e.error?.stack || e.message));
  await import('../public/assets/js/app.js');
  document.dispatchEvent(new Event('DOMContentLoaded'));
  await new Promise((r) => setTimeout(r, 25));
});

const cardFor = (id) => [...document.querySelectorAll('.listing-card')].find((c) => c.dataset.id === id);
// The browse card's own data-id is written unescaped in listingCardHTML, which
// is outside Step 1's scope, so a hostile id cannot be located by its raw value.
// Find the card by its visible title instead (used only for the tricky-id case).
const cardByTitle = (title) => [...document.querySelectorAll('.listing-card')]
  .find((c) => c.querySelector('.listing-title') && c.querySelector('.listing-title').textContent === title);
const overlay = (id) => document.getElementById(id);
const reportBtnInModal = () => document.getElementById('modalCard').querySelector('[data-action="report-listing"]');
const dispatchEscape = () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

function openListing(id) {
  cardFor(id).click();
}

async function submitReport() {
  document.getElementById('reportForm').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await tick();
}

// Drive the app out of demo mode (no-op once already non-demo): the demo-mode
// grid renders a retry banner; clicking it refetches real listings.
async function ensureNonDemo() {
  const retry = document.querySelector('.grid-retry-btn');
  if (retry) {
    listingsResponse = OK_LISTINGS;
    retry.click();
    await waitFor(() => !document.querySelector('.grid-retry-btn') && !!cardFor('lst-1'));
  }
}

beforeEach(() => {
  reportResponse = { ok: true, status: 200, json: async () => ({ success: true }) };
  fetchCalls.length = 0;
  ['reportModalOverlay', 'modalOverlay', 'storeModalOverlay'].forEach((id) => overlay(id).classList.remove('open'));
  document.getElementById('reportFormStatus').textContent = '';
  document.getElementById('reportSubmitBtn').textContent = 'Submit Report';
  document.getElementById('reportSubmitBtn').disabled = false;
  document.getElementById('report-details').value = '';
  document.getElementById('report-reason').value = '';
  document.getElementById('toast').textContent = '';
});

describe('Phase 8 — report modal hardening', () => {
  // MUST run first: the app starts in demo mode (initial /listings fetch fails).
  it('demo mode: opening a listing detail renders NO report button', async () => {
    openListing('demo1');
    expect(overlay('modalOverlay').classList.contains('open')).toBe(true);
    expect(reportBtnInModal()).toBeNull();
    // Restore non-demo for the remaining tests.
    await ensureNonDemo();
  });

  it('non-demo listing detail has a report button whose dataset.targetId is the listing id', async () => {
    await ensureNonDemo();
    openListing('lst-1');
    const btn = reportBtnInModal();
    expect(btn).not.toBeNull();
    expect(btn.dataset.targetId).toBe('lst-1');
  });

  it('a listing id with quote/angle characters round-trips exactly and the button has only the expected attributes', async () => {
    await ensureNonDemo();
    const card = cardByTitle('Tricky id listing');
    expect(card).toBeTruthy();
    // The card's unescaped data-id truncated the raw value; restore the real id
    // so the real click path opens the detail modal for this listing.
    card.dataset.id = 'a"b<c';
    card.click();
    const btn = reportBtnInModal();
    expect(btn).not.toBeNull();
    expect(btn.dataset.targetId).toBe('a"b<c');
    const attrs = [...btn.attributes].map((a) => a.name).sort();
    expect(attrs).toEqual(['class', 'data-action', 'data-target-id', 'style']);
  });

  it('clicking the report button opens the report modal and sets the target type and id', async () => {
    await ensureNonDemo();
    openListing('lst-1');
    reportBtnInModal().click();
    expect(overlay('reportModalOverlay').classList.contains('open')).toBe(true);
    expect(document.getElementById('report-target-type').value).toBe('listing');
    expect(document.getElementById('report-target-id').value).toBe('lst-1');
  });

  it('submitting with no reason makes no request and shows the prompt', async () => {
    await ensureNonDemo();
    openListing('lst-1');
    reportBtnInModal().click();
    await submitReport();
    expect(reportsCalls()).toHaveLength(0);
    expect(document.getElementById('reportFormStatus').textContent).toBe('⚠️ Please choose a reason.');
  });

  it('a valid submit sends exactly one POST with the expected body keys', async () => {
    await ensureNonDemo();
    openListing('lst-1');
    reportBtnInModal().click();
    document.getElementById('report-reason').value = 'scam';
    document.getElementById('report-details').value = 'This looks like a scam.';
    await submitReport();

    expect(reportsCalls()).toHaveLength(1);
    const call = reportsCalls()[0];
    expect(call.options.method).toBe('POST');
    expect(call.options.headers['Content-Type']).toBe('application/json');
    const body = JSON.parse(call.options.body);
    expect(Object.keys(body).sort()).toEqual(['details', 'reason', 'targetId', 'targetType']);
    expect(body).not.toHaveProperty('website');
    expect(body).not.toHaveProperty('honeypot');
  });

  it('after a success response the modal resets, closes, and the toast confirms', async () => {
    await ensureNonDemo();
    openListing('lst-1');
    reportBtnInModal().click();
    document.getElementById('report-reason').value = 'scam';
    document.getElementById('report-details').value = 'typed details';
    await submitReport();

    expect(overlay('reportModalOverlay').classList.contains('open')).toBe(false);
    expect(document.getElementById('report-reason').value).toBe('');
    expect(document.getElementById('report-details').value).toBe('');
    expect(document.getElementById('reportSubmitBtn').textContent).toBe('Submit Report');
    expect(document.getElementById('reportSubmitBtn').disabled).toBe(false);
    expect(document.getElementById('toast').textContent).toContain('Report submitted');
  });

  it('a 404 keeps the modal open, shows the server message, and Retry sends a second POST', async () => {
    await ensureNonDemo();
    reportResponse = { ok: false, status: 404, json: async () => ({ success: false, error: 'Target not found' }) };
    openListing('lst-1');
    reportBtnInModal().click();
    document.getElementById('report-reason').value = 'scam';
    document.getElementById('report-details').value = 'kept details';
    await submitReport();

    expect(document.getElementById('reportFormStatus').textContent).toBe('⚠️ Target not found');
    const btn = document.getElementById('reportSubmitBtn');
    expect(btn.textContent).toBe('Retry');
    expect(btn.disabled).toBe(false);
    expect(overlay('reportModalOverlay').classList.contains('open')).toBe(true);
    expect(document.getElementById('report-details').value).toBe('kept details');

    btn.click();
    await waitFor(() => reportsCalls().length === 2);
    expect(reportsCalls()).toHaveLength(2);
  });

  it('a 429 shows the rate-limit message', async () => {
    await ensureNonDemo();
    reportResponse = { ok: false, status: 429, json: async () => ({ success: false, error: 'Too many reports — please try again later' }) };
    openListing('lst-1');
    reportBtnInModal().click();
    document.getElementById('report-reason').value = 'scam';
    await submitReport();
    expect(document.getElementById('reportFormStatus').textContent).toBe('⚠️ Too many reports — please try again later');
  });

  it('a 400 shows the generic input message', async () => {
    await ensureNonDemo();
    reportResponse = { ok: false, status: 400, json: async () => ({ success: false, error: 'Invalid report' }) };
    openListing('lst-1');
    reportBtnInModal().click();
    document.getElementById('report-reason').value = 'scam';
    await submitReport();
    expect(document.getElementById('reportFormStatus').textContent).toBe('⚠️ Please check your input and try again.');
  });

  it('store flow: the store page report button sets the target type to store', async () => {
    await ensureNonDemo();
    cardFor('lst-store').querySelector('[data-action="open-store-page"]').click();
    await waitFor(() => document.querySelector('[data-action="report-store"]'));
    const storeReport = document.querySelector('[data-action="report-store"]');
    expect(storeReport).not.toBeNull();
    storeReport.click();
    expect(document.getElementById('report-target-type').value).toBe('store');
    expect(document.getElementById('report-target-id').value).toBe('sto-1');
  });

  it('Escape closes the report modal and leaves the listing modal open', async () => {
    await ensureNonDemo();
    openListing('lst-1');
    reportBtnInModal().click();
    expect(overlay('reportModalOverlay').classList.contains('open')).toBe(true);
    expect(overlay('modalOverlay').classList.contains('open')).toBe(true);

    dispatchEscape();

    expect(overlay('reportModalOverlay').classList.contains('open')).toBe(false);
    expect(overlay('modalOverlay').classList.contains('open')).toBe(true);
  });

  it('Escape closes the listing modal when it is the topmost modal', async () => {
    await ensureNonDemo();
    openListing('lst-1');
    expect(overlay('modalOverlay').classList.contains('open')).toBe(true);
    expect(overlay('reportModalOverlay').classList.contains('open')).toBe(false);

    dispatchEscape();

    expect(overlay('modalOverlay').classList.contains('open')).toBe(false);
  });

  it('Escape does not close the store modal', async () => {
    await ensureNonDemo();
    document.querySelector('[data-action="open-store-creation"]').click();
    expect(overlay('storeModalOverlay').classList.contains('open')).toBe(true);

    dispatchEscape();

    expect(overlay('storeModalOverlay').classList.contains('open')).toBe(true);
  });

  it('Escape with nothing open does nothing and throws nothing', async () => {
    await ensureNonDemo();
    expect(overlay('reportModalOverlay').classList.contains('open')).toBe(false);
    expect(overlay('modalOverlay').classList.contains('open')).toBe(false);
    expect(overlay('storeModalOverlay').classList.contains('open')).toBe(false);
    expect(() => dispatchEscape()).not.toThrow();
  });
});
