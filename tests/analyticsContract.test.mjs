/* eslint-disable no-undef -- document/window/localStorage/sessionStorage/Event are provided by the JSDOM instance constructed below, matching the domTerms/journeyFriction harness pattern */
// Analytics shipped-dark contract (PostHog EU). Drives the REAL app.js and the
// REAL analytics.js in a manual JSDOM instance (vitest's jsdom fork was flaky
// here for the other DOM suites) against the REAL public/index.html. All
// network traffic to /api is stubbed through fetch; PostHog itself is stubbed
// offline with `window.posthog = { capture }` — no request ever leaves the
// process and analytics.js's own loader is dark (ANALYTICS_ENABLED=false).
//
// Payment-status responses are keyed by invoiceId and remain staged after
// their test ends, because the app's poll timers legitimately keep retrying
// into later tests; leftovers must therefore always see their OWN invoice's
// response, never a later test's. The one intentionally never-confirmed flow
// (listingId-less status) runs LAST among submit tests so its 62s retry
// window cannot park isPaymentInFlight=true in front of another submit.
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

// Staged responses, keyed by the invoice id in the URL (paid flow) or by the
// store id in the URL (store flow). Unknown keys answer "still pending".
const statusByInvoice = {};
// The invoice id the CURRENT staged submit should be answered with (the real
// server mints it; the stub mirrors that flow). Set/cleared per paid flow.
let currentInitiateInvoice = null;
let storeListingResponse = null;

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
  globalThis.sessionStorage = dom.window.sessionStorage;
  globalThis.FormData = dom.window.FormData;
  globalThis.File = dom.window.File;
  globalThis.FileReader = dom.window.FileReader;
  dom.window.Element.prototype.getClientRects = function () { return [{}]; };

  const jsonResponse = (body) => ({ ok: true, status: 200, json: async () => body });
  const fetchImpl = async (url, options = {}) => {
    const u = String(url);
    if (u.includes('/terms/versions')) return jsonResponse({ success: true, versions: { GIKOMART_TERMS_OF_SERVICE: '1.0.0', STORE_OWNER_TERMS: '1.0.0', SELLER_TERMS: '1.0.0', BUYER_TERMS: '1.0.0' } });
    if (u.includes('/support-contact')) return jsonResponse({ success: true, support: { phoneLocal: '0776000000' } });
    if (u.includes('/listings/categories')) return jsonResponse({ success: true, categories: [{ id: 'electronics', name: 'Electronics', icon: '📱' }] });
    if (u.includes('/api/listings?page=1&limit=100') || u.includes('/listings?page=1&limit=100')) {
      return jsonResponse({
        success: true,
        listings: [{
          _id: 'lst-1', title: 'Fancy Gadget', category: 'electronics', condition: 'Good',
          price: 5000, description: 'A fixture listing used for the analytics contract.', location: 'Njoro',
          sellerName: 'Test Seller', sellerWhatsapp: '0700000000', views: 3, images: [],
        }],
        total: 1, page: 1, totalPages: 1,
      });
    }
    if (u.includes('/api/listings')) {
      return jsonResponse({
        success: true,
        listings: [{
          _id: 'lst-1', title: 'Fancy Gadget', category: 'electronics', condition: 'Good',
          price: 5000, description: 'A fixture listing used for the analytics contract.', location: 'Njoro',
          sellerName: 'Test Seller', sellerWhatsapp: '0700000000', views: 3, images: [],
        }],
        total: 1, page: 1, totalPages: 1,
      });
    }
    if (u.includes('/payments/status/')) {
      const invoiceId = decodeURIComponent(u.split('/payments/status/')[1] || '');
      const staged = statusByInvoice[invoiceId] || {};
      if (staged.initiate) {
        // Isolation tests never confirm their invoice: answer the mandatory
        // initiate-shaped response, then keep it pending forever so the flow
        // cannot hit a success branch while the next test is submitting.
        return jsonResponse({ success: true, message: 'STK push sent. Check your phone.', amount: 50, invoiceId, ownerToken: 'tok-' + invoiceId });
      }
      return jsonResponse(staged.body || { success: true });
    }
    if (u.includes('/payments/initiate-listing')) {
      // The real server generates the invoiceId; the stub mirrors the flow
      // with the invoice id the current test staged (or a fixed fallback).
      const invoiceId = (typeof currentInitiateInvoice === 'string' && currentInitiateInvoice) || 'inv-stub';
      return jsonResponse({ success: true, message: 'STK push sent. Check your phone.', amount: 50, invoiceId, ownerToken: 'tok-' + invoiceId });
    }
    if (u.includes('/stores/')) {
      if (u.includes('/listings') && options.method === 'POST') {
        if (!storeListingResponse) throw new Error('store listing response not staged');
        return storeListingResponse;
      }
      return jsonResponse({ success: true, stores: [], store: { _id: 'sto-1', name: 'S', slug: 's', category: 'electronics' }, listingCount: 0 });
    }
    return jsonResponse({ success: true });
  };
  const fetchMock = vi.fn(fetchImpl);
  vi.stubGlobal('fetch', fetchMock);
  globalThis.__fetchMock = fetchMock;

  // Set up the fetch stub BEFORE analytics/app load; analytics stays dark.
  await import('../public/assets/js/analytics.js');
  await import('../public/assets/js/app.js');
  document.dispatchEvent(new dom.window.Event('DOMContentLoaded'));
  await new Promise((r) => setTimeout(r, 30));
});

const flip = (ms = 15) => new Promise((r) => setTimeout(r, ms));

const captures = () => (globalThis.window.posthog && Array.isArray(globalThis.window.posthog.capture.mock.calls))
  ? globalThis.window.posthog.capture.mock.calls
  : [];

function makeListing(over = {}) {
  return { _id: 'lst-1', category: 'electronics', price: 5000, ...over };
}

function clickAndWait(selector) {
  const el = document.querySelector(selector);
  if (!el) throw new Error(`missing element: ${selector}`);
  el.click();
  return flip(10);
}

// Stage the whole paid flow for one invoice, then submit the sell form
// through the REAL delegated submit listener.
async function runPaidFlow(invoiceId, statusBody) {
  currentInitiateInvoice = invoiceId;
  statusByInvoice[invoiceId] = { initiate: true };
  // Fill the sell form (required fields) and submit.
  document.getElementById('f-title').value = 'Analytics contract listing ' + invoiceId;
  document.getElementById('f-category').value = 'electronics';
  document.getElementById('f-condition').value = 'New';
  document.getElementById('f-price').value = '7000';
  document.getElementById('f-description').value = 'Analytics contract test listing.';
  document.getElementById('f-seller').value = 'Alice';
  document.getElementById('f-whatsapp').value = '0711999988';
  document.getElementById('listingPhone').value = '0711999988';
  document.getElementById('sellForm').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  // Attempt 1 goes out immediately at submit; keep "initiate" staged for it.
  await flip(15);
  // Then flip to the REAL status body; the app's 2s backoff retry reads it.
  statusByInvoice[invoiceId] = { body: statusBody || { success: true } };
  await flip(2100);
  currentInitiateInvoice = null;
}

beforeEach(() => {
  // Fresh PostHog stub per test (fresh capture counts).
  const ph = { capture: vi.fn() };
  Object.defineProperty(globalThis.window, 'posthog', { configurable: true, value: ph, writable: true });
  // sessionStorage-backed dedup guard resets with the storage itself.
  try { globalThis.sessionStorage.clear(); } catch { /* a broken-storage test restores it below */ }
  document.getElementById('formStatus').textContent = '';
  try { localStorage.clear(); } catch { /* ignore */ }
});

// ─── Test 1: listing_viewed ─────────────────────────────────────────────
describe('listing_viewed', () => {
  it('rendering the grid (no click) yields 0 capture calls', async () => {
    await flip(10);
    expect(captures()).toHaveLength(0);
  });

  it('clicking one browse card yields exactly 1 call with deep-equal properties (source browse)', async () => {
    await clickAndWait('#listingGrid .listing-card');
    expect(captures()).toHaveLength(1);
    const [name, props] = captures()[0];
    expect(name).toBe('listing_viewed');
    expect(props).toEqual({ listing_id: 'lst-1', category: 'electronics', price_band: '5,000-14,999', source: 'browse' });
  });

  it('clicking a seller-dashboard card yields 0 calls (dashboard is the seller\u2019s own view)', async () => {
    // An owner token puts lst-1 into the seller's dashboard grid.
    localStorage.setItem('gikomart_ownerToken:lst-1', 'tok-owner');
    await clickAndWait('.nav-link[data-view="dashboard"]');
    await flip(30);
    expect(captures()).toHaveLength(0); // dashboard render itself: no event
    const grid = document.getElementById('myListingGrid');
    const card = grid.querySelector('.listing-card');
    if (!card) throw new Error('dashboard card did not render');
    card.click();
    await flip(10);
    expect(captures()).toHaveLength(0);
  });

  it('opening the same listing twice yields 2 calls', async () => {
    await clickAndWait('#listingGrid .listing-card');
    document.getElementById('modalOverlay').classList.remove('open');
    await clickAndWait('#listingGrid .listing-card');
    expect(captures()).toHaveLength(2);
  });

  it('price bands: <1,000 / >=50,000 / unknown', () => {
    const giko = globalThis.window.gikoAnalytics;
    giko.listingViewed(makeListing({ price: 800 }), 'browse');
    expect(captures()[0][1].price_band).toBe('<1,000');
    giko.listingViewed(makeListing({ price: 65000 }), 'browse');
    expect(captures()[1][1].price_band).toBe('>=50,000');
    giko.listingViewed(makeListing({ price: undefined }), 'browse');
    expect(captures()[2][1].price_band).toBe('unknown');
  });
});

// ─── Test 2: seller_contact_clicked ─────────────────────────────────────
describe('seller_contact_clicked', () => {
  it('clicking the contact button yields exactly 1 call with deep-equal { listing_id, source: detail }; no WhatsApp/phone leaks; buyer-gate cancel adds 0 calls', async () => {
    await clickAndWait('#listingGrid .listing-card');
    captures().length = 0; // drop the listing_viewed call
    await clickAndWait('.contact-btn');
    expect(captures()).toHaveLength(1);
    const [name, props] = captures()[0];
    expect(name).toBe('seller_contact_clicked');
    expect(props).toEqual({ listing_id: 'lst-1', source: 'detail' });
    const serialized = JSON.stringify(captures().map((c) => c[1]));
    expect(serialized).not.toMatch(/wa\.me|api\.whatsapp|whatsapp/i);
    expect(serialized).not.toMatch(/(?:\+?254|0)[17]\d{8}/);
    // Cancel the buyer gate: no extra analytics call.
    const cancel = document.querySelector('[data-action="buyer-gate-cancel"]');
    if (cancel) {
      cancel.click();
      await flip(5);
    }
    expect(captures()).toHaveLength(1); // still just the one contact call
  });
});

// ─── Test 3: listing_created (paid flow) ────────────────────────────────
describe('listing_created (paid flow)', () => {
  it('exactly 1 call with the submitted form\u2019s category and price_band', async () => {
    await runPaidFlow('inv1', { success: true, listingId: 'L1' });
    expect(captures()).toHaveLength(1);
    const [name, props] = captures()[0];
    expect(name).toBe('listing_created');
    expect(props).toEqual({ listing_id: 'L1', source: 'paid', category: 'electronics', price_band: '5,000-14,999' });
  });

  it('calling the success path a second time for the same listingId yields still exactly 1 call total', async () => {
    await runPaidFlow('inv2', { success: true, listingId: 'L2' });
    expect(captures()).toHaveLength(1);
    // Second visit through the same success branch via the direct API path.
    globalThis.window.gikoAnalytics.listingCreated('L2', 'paid', 'inv2');
    expect(captures()).toHaveLength(1);
  });

  it('a status response without listingId yields 0 calls — and its poller is drained to a terminal state so later submits are never blocked by isPaymentInFlight', async () => {
    const invoiceId = 'inv-pending-drain';
    await runPaidFlow(invoiceId, { success: true }); // never confirms
    expect(captures()).toHaveLength(0);
    // Drain: flip the SAME invoice to a terminal failure so the app's next
    // backoff attempt clears isPaymentInFlight instead of retrying for 62s.
    statusByInvoice[invoiceId] = { body: { success: true, status: 'failed', failedCode: '1032' } };
    await flip(7000);
    // Terminal state reached: the App's own cancelled-failure copy (failedCode
    // 1032) — either wording proves the flow left the pending state.
    expect(document.getElementById('formStatus').textContent).toContain('No listing was created');
  });

  it('a failed status yields 0 calls', async () => {
    await runPaidFlow('inv3', { success: true, status: 'failed', failedCode: '1032' });
    expect(captures()).toHaveLength(0);
  });

  it('a failed status yields 0 calls', async () => {
    await runPaidFlow('inv3', { success: true, status: 'failed', failedCode: '1032' });
    expect(captures()).toHaveLength(0);
  });

  it('cache miss: listingCreated directly with an unknown invoiceId yields deep-equal { listing_id, source } only', () => {
    globalThis.window.gikoAnalytics.listingCreated('L9', 'paid', 'inv-unknown');
    expect(captures()).toHaveLength(1);
    const [, props] = captures()[0];
    expect(props).toEqual({ listing_id: 'L9', source: 'paid' });
  });
});

// ─── Test 4: listing_created (store flow) ──────────────────────────────
describe('listing_created (store flow)', () => {
  async function armStoreContextAndSubmit() {
    // Drive the REAL delegation: a data-action=add-listing button (exactly what
    // renderMyStore renders) opens the sell form in store context; the submit
    // then publishes through POST /api/stores/:id/listings.
    const el = document.createElement('button');
    el.setAttribute('data-action', 'add-listing');
    el.setAttribute('data-store-id', 'sto-1');
    el.setAttribute('data-available', '3');
    document.body.appendChild(el);
    el.click();
    el.remove();
    document.getElementById('f-title').value = 'Store-analytics listing';
    document.getElementById('f-category').value = 'electronics';
    document.getElementById('f-condition').value = 'New';
    document.getElementById('f-price').value = '2500';
    document.getElementById('f-description').value = 'Store publish contract test.';
    document.getElementById('f-seller').value = 'Bob';
    document.getElementById('f-whatsapp').value = '0711999977';
    document.getElementById('sellForm').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await flip(20);
    // Leave store context so the NEXT test's submission is a normal paid flow.
    document.querySelector('.nav-link[data-view="browse"]')?.click();
    await flip(5);
  }

  it('a stubbed 201 create with a full listing object yields 1 call with exactly the allowed properties; no title/description/whatsapp leak', async () => {
    storeListingResponse = {
      ok: true, status: 201, json: async () => ({
        success: true,
        listing: { _id: 'S1', category: 'electronics', price: 2500, title: 'SECRET-TITLE-XYZ', description: 'SECRET-DESC-XYZ', sellerWhatsapp: '+254712345678 Secret' },
      }),
    };
    await armStoreContextAndSubmit();
    expect(captures()).toHaveLength(1);
    const [name, props] = captures()[0];
    expect(name).toBe('listing_created');
    expect(props).toEqual({ listing_id: 'S1', source: 'store', category: 'electronics', price_band: '1,000-4,999' });
    const serialized = JSON.stringify(props);
    expect(serialized).not.toContain('SECRET-TITLE-XYZ');
    expect(serialized).not.toContain('SECRET-DESC-XYZ');
    expect(serialized).not.toMatch(/254712345678|Secret/);
  });

  it('a 400 and a 403 response yield 0 calls', async () => {
    storeListingResponse = { ok: false, status: 400, json: async () => ({ success: false, error: 'bad' }) };
    await armStoreContextAndSubmit();
    expect(captures()).toHaveLength(0);
    storeListingResponse = { ok: false, status: 403, json: async () => ({ success: false, error: 'denied' }) };
    await armStoreContextAndSubmit();
    expect(captures()).toHaveLength(0);
  });
});

// ─── Test 5: failure isolation ──────────────────────────────────────────
describe('failure isolation: broken analytics never blocks the app', () => {
  async function submitPaidAndAssertPost(invoiceId) {
    const before = globalThis.__fetchMock.mock.calls.filter(([u]) => String(u).includes('/payments/initiate-listing')).length;
    currentInitiateInvoice = invoiceId;
    statusByInvoice[invoiceId] = { initiate: true, isolate: true };
    document.getElementById('f-title').value = 'Isolation listing ' + invoiceId;
    document.getElementById('f-category').value = 'electronics';
    document.getElementById('f-condition').value = 'New';
    document.getElementById('f-price').value = '7000';
    document.getElementById('f-description').value = 'Failure isolation helper.';
    document.getElementById('f-seller').value = 'Carol';
    document.getElementById('f-whatsapp').value = '0711999966';
    document.getElementById('listingPhone').value = '0711999966';
    document.getElementById('sellForm').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    for (let i = 0; i < 8; i++) {
      await flip(25);
      const posted = globalThis.__fetchMock.mock.calls.filter(([u]) => String(u).includes('/payments/initiate-listing')).length;
      if (posted - before >= 1) break;
    }
    const posted = globalThis.__fetchMock.mock.calls.filter(([u]) => String(u).includes('/payments/initiate-listing')).length;
    expect(posted - before).toBe(1);
    // Drain this invoice's poller to a TERMINAL failure so its 2s-backoff
    // retry chain ends and isPaymentInFlight clears before the NEXT test's
    // submit (a live pending poller would silently block later submissions).
    statusByInvoice[invoiceId] = { body: { success: true, status: 'failed', failedCode: '1032' } };
    await flip(7000);
    expect(document.getElementById('formStatus').textContent).toContain('No listing was created');
    currentInitiateInvoice = null;
  }

  it('(a) — runs LAST so no paid flow of its own precedes the next tests; posthog undefined: card click still opens the modal; contact click still opens the buyer gate; submit still POSTs', async () => {
    delete globalThis.window.posthog;
    await clickAndWait('#listingGrid .listing-card');
    expect(document.getElementById('modalOverlay').classList.contains('open')).toBe(true);
    await clickAndWait('.contact-btn');
    expect(document.getElementById('modalCard').textContent).toContain('Contact Seller');
    await submitPaidAndAssertPost('inv-a');
  });

  it('(b) window.posthog.capture throws: app still works end to end', async () => {
    globalThis.window.posthog = { capture: vi.fn(() => { throw new Error('PostHog exploded'); }) };
    // Analytics' own capture wrapper swallows the throw before it can escape into app code.
    await clickAndWait('#listingGrid .listing-card');
    expect(document.getElementById('modalOverlay').classList.contains('open')).toBe(true);
    await clickAndWait('.contact-btn');
    expect(document.getElementById('modalCard').textContent).toContain('Contact Seller');
    await submitPaidAndAssertPost('inv-b');
  });

  it('(c) window.gikoAnalytics undefined (analytics.js absent): app still works end to end', async () => {
    const prev = globalThis.window.gikoAnalytics;
    delete globalThis.window.gikoAnalytics;
    try {
      await clickAndWait('#listingGrid .listing-card');
      expect(document.getElementById('modalOverlay').classList.contains('open')).toBe(true);
      await clickAndWait('.contact-btn');
      expect(document.getElementById('modalCard').textContent).toContain('Contact Seller');
      await submitPaidAndAssertPost('inv-c');
    } finally {
      globalThis.window.gikoAnalytics = prev;
    }
  });

  it('(d) sessionStorage get/set throw: guard falls back to memory, one event still fires for a new listing', () => {
    const origSession = globalThis.window.sessionStorage;
    const broken = {
      getItem: () => { throw new Error('storage read failed'); },
      setItem: () => { throw new Error('storage write failed'); },
      removeItem: () => { throw new Error('storage remove failed'); },
      clear: () => { throw new Error('storage clear failed'); },
    };
    Object.defineProperty(globalThis.window, 'sessionStorage', { configurable: true, value: broken });
    try {
      globalThis.window.gikoAnalytics.listingCreated('LX', 'paid', 'inv-x', 'electronics', 9000);
      expect(captures()).toHaveLength(1);
      expect(captures()[0][1].listing_id).toBe('LX');
      // Same id a second time: memory fallback still dedupes.
      globalThis.window.gikoAnalytics.listingCreated('LX', 'paid', 'inv-x', 'electronics', 9000);
      expect(captures()).toHaveLength(1);
      // A different id fires again.
      globalThis.window.gikoAnalytics.listingCreated('LY', 'paid', 'inv-y', 'electronics', 9000);
      expect(captures()).toHaveLength(2);
    } finally {
      Object.defineProperty(globalThis.window, 'sessionStorage', { configurable: true, value: origSession });
    }
  });
});

// ─── Test 6: config contract ────────────────────────────────────────────
describe('config contract', () => {
  it('_buildConfig() carries exactly the shipped keys and values, with before_send a function', () => {
    const cfg = globalThis.window.gikoAnalytics._buildConfig();
    const expected = {
      api_host: 'https://eu.i.posthog.com',
      autocapture: false,
      capture_pageview: false,
      capture_pageleave: false,
      disable_session_recording: true,
      persistence: 'memory',
      person_profiles: 'never',
      rageclick: false,
      capture_dead_clicks: false,
      capture_heatmaps: false,
      capture_exceptions: false,
      capture_performance: false,
      disable_surveys: true,
      advanced_disable_flags: true,
      disable_web_experiments: true,
      advanced_disable_toolbar_metrics: true,
    };
    expect(Object.keys(cfg).sort()).toEqual(Object.keys(expected).concat(['before_send']).sort());
    for (const [k, v] of Object.entries(expected)) expect(cfg[k]).toBe(v);
    expect(typeof cfg.before_send).toBe('function');
  });
});

// ─── Test 7: before_send URL scrubbing ──────────────────────────────────
describe('before_send URL scrubbing', () => {
  const STRIP = ['$current_url', '$pathname', '$host', '$referrer', '$referring_domain', '$initial_current_url', '$initial_pathname', '$initial_host', '$initial_referrer', '$initial_referring_domain'];
  const noKey = (obj, k) => !obj || !Object.prototype.hasOwnProperty.call(obj, k);

  it('strips all ten URL keys from properties, $set and $set_once; keeps listing_id', () => {
    const event = {
      properties: {
        '$current_url': 'https://gikomart.test/x', '$pathname': '/x', '$host': 'gikomart.test',
        '$referrer': 'https://gikomart.test/r', '$referring_domain': 'gikomart.test',
        '$initial_current_url': 'https://gikomart.test/0', '$initial_pathname': '/0', '$initial_host': 'gikomart.test',
        '$initial_referrer': 'https://gikomart.test/ir', '$initial_referring_domain': 'gikomart.test',
        listing_id: 'lst-1',
        '$set': { '$initial_pathname': '/0', keep: 1 },
        '$set_once': { '$referring_domain': 'gikomart.test', keep_once: 2 },
      },
      '$set': { '$initial_host': 'gikomart.test' },
      '$set_once': { '$pathname': '/x' },
    };
    const out = globalThis.window.gikoAnalytics._beforeSend(event);
    expect(out).toBe(event);
    const p = out.properties;
    for (const k of STRIP) {
      expect(noKey(p, k)).toBe(true);
      expect(noKey(p.$set, k)).toBe(true);
      expect(noKey(p.$set_once, k)).toBe(true);
      expect(noKey(out.$set, k)).toBe(true);
      expect(noKey(out.$set_once, k)).toBe(true);
    }
    expect(p.listing_id).toBe('lst-1');
    expect(p.$set.keep).toBe(1);
    expect(p.$set_once.keep_once).toBe(2);
  });

  it('_beforeSend(null) returns null', () => {
    expect(globalThis.window.gikoAnalytics._beforeSend(null)).toBe(null);
  });

  it('an event whose properties getter throws returns null', () => {
    const event = {
      get properties() { throw new Error('boom'); },
    };
    expect(globalThis.window.gikoAnalytics._beforeSend(event)).toBe(null);
  });
});

// ─── Test 8: shipped dark (no network, no script node) ──────────────────
describe('shipped dark by default', () => {
  it('analytics.js replaces nothing and fetches nothing', () => {
    // Loader is a no-op: window.posthog must not have been replaced by a
    // real instance — it is the test stub we installed per test.
    const ph = globalThis.window.posthog;
    if (ph) {
      expect(typeof ph.capture).toBe('function');
      expect(Object.keys(ph)).toEqual(['capture']);
    }
    expect(document.querySelectorAll('script[src*="posthog"]').length).toBe(0);
    const calls = globalThis.fetch.mock.calls;
    expect(calls.filter(([u]) => String(u).includes('posthog')).length).toBe(0);
  });
});
