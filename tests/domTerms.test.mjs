/* eslint-disable no-undef -- document/localStorage/Event are provided by the JSDOM instance constructed below, not by the Node environment */
// Store-modal terms freshness (audit Fix 4) — drives the REAL app.js against
// the REAL public/index.html DOM (no app.js refactor needed): opening the
// modal bakes the then-current terms versions into the acceptance notice;
// submit must re-fetch versions and re-render so BOTH the transmitted
// acceptance token and the visible notice carry the CURRENT version, even if
// the server bumped the terms after the modal opened.
//
// A manual JSDOM instance on the default node environment is used instead of
// vitest's jsdom environment pragma (its forks worker failed to start here),
// which also keeps server.js out of the picture entirely: app.js only talks
// to the server over fetch, which is stubbed below.
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

const V1 = { GIKOMART_TERMS_OF_SERVICE: '1.0.0', STORE_OWNER_TERMS: '1.0.0', SELLER_TERMS: '1.0.0', BUYER_TERMS: '1.0.0' };
const V2 = { GIKOMART_TERMS_OF_SERVICE: '1.0.1', STORE_OWNER_TERMS: '1.0.1', SELLER_TERMS: '1.0.1', BUYER_TERMS: '1.0.1' };

// Whatever this holds when /terms/versions is called is what the server "is".
let nextVersions = V1;
// What /api/upload answers. The 503 test flips this later to prove the branch.
let uploadResponse = { ok: false, status: 503, json: async () => ({}), text: async () => '' };
// What /api/listings answers. A real (non-demo) listing is served from the
// start so the boost section's ownership gate can be exercised through the real
// UI: the card is rendered during init, and opening it re-evaluates ownership.
const listingsResponse = {
  ok: true,
  status: 200,
  json: async () => ({
    success: true,
    listings: [{
      _id: 'lst-dom', title: 'Owned DOM listing', category: 'Electronics', condition: 'Good',
      price: 1000, description: 'A listing used to exercise the boost gate.', location: 'Njoro',
      sellerName: 'Test', views: 1, images: [], featured: false,
    }],
  }),
};
const fetchCalls = [];
// What /api/terms/contact-acceptance answers. Tests override it per case.
let contactAcceptanceResponse = { ok: true, status: 200, json: async () => ({ success: true, sellerWhatsapp: '0712222222' }) };
// window.open must never fire for the contact flow — the buyer gets a real link.
const waOpens = vi.fn();

beforeAll(async () => {
  const { JSDOM, VirtualConsole } = await import('jsdom');
  const { readFileSync } = await import('node:fs');
  const path = await import('node:path');
  // vitest runs from the project root; import.meta.url is not a file: URL here.
  const html = readFileSync(path.join(process.cwd(), 'public', 'index.html'), 'utf8');
  // Surface jsdom-captured errors (unhandled exceptions inside event listeners
  // etc.) — without this they vanish silently.
  const virtualConsole = new VirtualConsole();
  virtualConsole.forwardTo(console); // jsdom 29: forwardTo (was sendTo)
  const dom = new JSDOM(html, { url: 'https://gikomart.test/', virtualConsole });

  // Expose the jsdom realm's DOM globals to app.js (same names it uses in a
  // real browser).
  globalThis.document = dom.window.document;
  globalThis.window = dom.window;
  globalThis.Event = dom.window.Event;
  globalThis.localStorage = dom.window.localStorage;
  // The upload flow builds FormData and reads the chosen file with FileReader —
  // both must come from the jsdom realm (Node has no global FileReader).
  globalThis.FormData = dom.window.FormData;
  globalThis.File = dom.window.File;
  globalThis.FileReader = dom.window.FileReader;
  dom.window.open = waOpens;

  const jsonResponse = (body) => ({ ok: true, status: 200, json: async () => body });
  vi.stubGlobal('fetch', vi.fn(async (url, options = {}) => {
    const u = String(url);
    fetchCalls.push({ url: u, options });
    if (u.includes('/terms/versions')) return jsonResponse({ success: true, versions: nextVersions });
    if (u.includes('/payments/initiate-store-plan')) {
      return jsonResponse({ success: true, message: 'STK push sent. Check your phone.', amount: 150, invoiceId: 'INV-STG-1', ownerToken: 'tok-abc' });
    }
    if (u.includes('/payments/status/')) return jsonResponse({ success: true, storeId: 'sto-9' });
    if (u.includes('/terms/contact-acceptance')) return contactAcceptanceResponse;
    if (u.includes('/listings') && !u.includes('/listings/categories')) return listingsResponse;
    if (u.includes('/upload')) return uploadResponse;
    return { ok: false, status: 404, json: async () => ({ success: false }) };
  }));

  dom.window.addEventListener('error', (e) => console.log('WINDOW-ERROR:', e.error?.stack || e.message));
  await import('../public/assets/js/app.js');
  // document readyState is 'complete' when tests run, so app.js's
  // DOMContentLoaded listener never fires on its own — dispatch it manually.
  // The handler is async (it awaits loadTermsVersions before building any
  // acceptance notice), so let the init chain settle before asserting.
  document.dispatchEvent(new Event('DOMContentLoaded'));
  await new Promise((r) => setTimeout(r, 25));
});

describe('Store modal terms freshness (Fix 4)', () => {
  it('re-fetches terms versions at submit: acceptance token AND visible notice carry the bumped version', async () => {
    // Init consumed exactly one versions fetch, answering v1.0.0.
    expect(fetchCalls.filter((c) => c.url.includes('/terms/versions'))).toHaveLength(1);

    // 1. Open the store modal → notice is baked with v1.0.0 (the stale state
    //    that Fix 4 must correct).
    document.querySelector('[data-action="open-store-creation"]').click();
    const noticeBefore = [...document.querySelectorAll('#storeCreationForm .terms-acceptance .terms-version')].map((s) => s.textContent);
    expect(noticeBefore).toEqual(['v1.0.0', 'v1.0.0']);

    // 2. The server bumps the terms while the modal is open.
    nextVersions = V2;

    // 3. Fill the M-Pesa number and submit through the REAL delegated submit
    //    listener (storeModalCard → handleStorePlanSubmit).
    document.getElementById('sc-phoneNumber').value = '0712345678';
    const form = document.getElementById('storeCreationForm');
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

    // 4. The submit re-fetched versions, transmitted v1.0.1, and the whole
    //    post-payment flow completed: the pending owner token was saved,
    //    adopted onto the created store id by the status poll, and the
    //    pending key consumed.
    let storeToken = null;
    for (let i = 0; i < 60; i++) {
      storeToken = localStorage.getItem('gikomart_storeToken:sto-9');
      if (storeToken === 'tok-abc') break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(storeToken).toBe('tok-abc');
    expect(localStorage.getItem('gikomart_pendingToken:INV-STG-1')).toBeNull();

    const initiate = fetchCalls.find((c) => c.url.includes('/payments/initiate-store-plan'));
    const acceptance = JSON.parse(initiate.options.body).acceptance;
    expect(acceptance.accepted).toBe(true);
    expect(acceptance.storeOwnerTermsVersion).toBe('1.0.1');
    expect(acceptance.gikomartTermsVersion).toBe('1.0.1');

    // 5. The VISIBLE notice was re-rendered to v1.0.1 too.
    const noticeAfter = [...document.querySelectorAll('#storeCreationForm .terms-acceptance .terms-version')].map((s) => s.textContent);

    expect(noticeAfter).toEqual(['v1.0.1', 'v1.0.1']);
  });
});

describe('Boost UI — owner-only (Phase 2, Step 3)', () => {
  const openOwnedListingModal = async (ownerToken) => {
    localStorage.clear();
    if (ownerToken) localStorage.setItem('gikomart_ownerToken:lst-dom', ownerToken);
    // The card was rendered during init (listingsResponse is a real listing).
    let card = null;
    for (let i = 0; i < 40 && !card; i++) {
      card = document.querySelector('.listing-card[data-id="lst-dom"]');
      if (!card) await new Promise((r) => setTimeout(r, 25));
    }
    expect(card, 'the real listing card must be rendered').not.toBeNull();
    card.click();
    await new Promise((r) => setTimeout(r, 10));
  };

  it('does not render the boost section when no owner token is stored', async () => {
    await openOwnedListingModal(null);
    const modalCard = document.getElementById('modalCard');
    expect(modalCard.querySelector('#boostPayBtn')).toBeNull();
    expect(modalCard.querySelector('[data-action="initiate-boost"]')).toBeNull();
  });

  it('renders the boost section and sends X-Owner-Token on the boost request for the owner', async () => {
    await openOwnedListingModal('dom-owner-token');
    const btn = document.getElementById('modalCard').querySelector('#boostPayBtn');
    expect(btn).not.toBeNull();

    document.getElementById('boostPhone').value = '0712345678';
    btn.click();
    await new Promise((r) => setTimeout(r, 50));

    const boostCall = fetchCalls.find((c) => c.url.includes('/payments/boost'));
    expect(boostCall).toBeTruthy();
    expect(boostCall.options.headers['X-Owner-Token']).toBe('dom-owner-token');
  });
});

describe('Upload 503 handling (Rule D)', () => {
  it('shows the busy message on a 503 and keeps the chosen file for a manual retry', async () => {
    const input = document.getElementById('f-image');
    const file = new window.File([new Uint8Array([1, 2, 3])], 'photo.png', { type: 'image/png' });
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    uploadResponse = { ok: false, status: 503, json: async () => ({}), text: async () => '' };

    input.dispatchEvent(new Event('change'));
    await new Promise((r) => setTimeout(r, 50));

    const status = document.getElementById('imageUploadStatus');
    expect(status.textContent).toBe('Server is busy — please try again in a moment');
    expect(input.files[0]).toBe(file);
  });
});

// Phase 3, Step 3 — the buyer obtains the seller contact only through an
// explicit WhatsApp link released by the server after a recorded acceptance.
describe('Buyer contact release (Phase 3, Step 3)', () => {
  beforeEach(() => {
    contactAcceptanceResponse = { ok: true, status: 200, json: async () => ({ success: true, sellerWhatsapp: '0712222222' }) };
    waOpens.mockClear();
  });

  // Open the seeded listing, then click Contact Seller to enter the gate.
  const openContactGate = async () => {
    const card = document.querySelector('.listing-card[data-id="lst-dom"]');
    expect(card, 'the real listing card must be rendered').not.toBeNull();
    card.click();
    await new Promise((r) => setTimeout(r, 10));
    const contactBtn = document.getElementById('modalCard').querySelector('.contact-btn');
    expect(contactBtn, 'the modal contact button must exist').not.toBeNull();
    contactBtn.click();
    await new Promise((r) => setTimeout(r, 10));
  };

  it('opens the gate with no known number and never auto-opens WhatsApp', async () => {
    await openContactGate();

    expect(document.querySelector('[data-action="buyer-gate-continue"]')).not.toBeNull();
    expect(waOpens).not.toHaveBeenCalled();
    // Opening the gate must not yet hit the release endpoint.
    expect(fetchCalls.some((c) => c.url.includes('/terms/contact-acceptance'))).toBe(false);
  });

  it('continuing posts the listingId (no seller number) and renders an Open WhatsApp link', async () => {
    await openContactGate();

    document.querySelector('[data-action="buyer-gate-continue"]').click();
    await new Promise((r) => setTimeout(r, 50));

    const call = fetchCalls.find((c) => c.url.includes('/terms/contact-acceptance'));
    expect(call).toBeTruthy();
    const body = JSON.parse(call.options.body);
    expect(body.listingId).toBe('lst-dom');
    expect(body.sellerWhatsapp).toBeUndefined();

    const anchor = document.getElementById('buyerGateActions').querySelector('a');
    expect(anchor, 'an Open WhatsApp anchor must be rendered').not.toBeNull();
    expect(anchor.textContent).toContain('Open WhatsApp');
    expect(anchor.getAttribute('href')).toContain('254712222222');
    expect(anchor.getAttribute('target')).toBe('_blank');
    expect(anchor.getAttribute('rel')).toContain('noopener');
    expect(waOpens).not.toHaveBeenCalled();
  });

  it('a 404 keeps the modal open, shows the error, and renders no link', async () => {
    contactAcceptanceResponse = { ok: false, status: 404, json: async () => ({ success: false, error: 'Listing not found' }) };
    await openContactGate();

    document.querySelector('[data-action="buyer-gate-continue"]').click();
    await new Promise((r) => setTimeout(r, 50));

    const actions = document.getElementById('buyerGateActions');
    expect(actions.querySelector('a')).toBeNull();
    // Gate still open and retryable, toast carries the server message.
    expect(document.querySelector('[data-action="buyer-gate-continue"]')).not.toBeNull();
    expect(document.getElementById('toast').textContent).toContain('Listing not found');
    expect(waOpens).not.toHaveBeenCalled();
  });

  it('an OK response with no sellerWhatsapp re-enables the Continue button with a toast', async () => {
    contactAcceptanceResponse = { ok: true, status: 200, json: async () => ({ success: true }) };
    await openContactGate();

    document.querySelector('[data-action="buyer-gate-continue"]').click();
    await new Promise((r) => setTimeout(r, 50));

    const continueBtn = document.querySelector('[data-action="buyer-gate-continue"]');
    expect(continueBtn.disabled).toBe(false);
    expect(continueBtn.textContent).toBe('Continue & Contact Seller');
    expect(document.getElementById('buyerGateActions').querySelector('a')).toBeNull();
    expect(waOpens).not.toHaveBeenCalled();
  });
});
