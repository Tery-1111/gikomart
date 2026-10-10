/* eslint-disable no-undef -- document/window/localStorage/Event come from the JSDOM instance constructed below, matching the house manual-JSDOM harness (domTerms/storeSave/history) */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

// SELLER JOURNEY — one chained regression test through the REAL app.js:
//   Store-creation residency (open modal → select plan → fill form → submit →
//   the payment status poll resolves the new store, adopting its owner token —
//   the app's established creation resolution path) → the My Store management
//   panel renders from the (locally stateful) fetch stub → `+ Add Listing`
//   opens the sell form in store context → real submit publishes through
//   POST /api/stores/:id/listings → the displayed allowance decrements →
//   returning to My Store shows the updated count read back through
//   renderMyStore()'s normal fetch path.
// Harness conventions copied from tests/storeSave.test.mjs and
// tests/storeListingsUi.test.mjs (manual JSDOM on the node environment, real
// public/index.html, stubbed fetch, app.js imported after globals wired).

const createdListingCalls = [];
let listingCountUsed = 2; // closure-backed server state; mutated ONLY by a valid store-listing POST
const calls = [];
const jsonResponse = (body) => ({ ok: true, status: 200, json: async () => body });

const STORE = {
  _id: 'sto-ui',
  name: 'Rig Store',
  category: 'Electronics',
  slug: 'rig-store',
  status: 'active',
  plan: 'starter_weekly',
  listing_limit: 5,
  expires_at: new Date(Date.now() + 7 * 86400000).toISOString(),
};

const OWNER_TOKEN = 'seller-journey-store-token';

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
  dom.window.Element.prototype.getClientRects = function () { return [{}]; };

  vi.stubGlobal('fetch', vi.fn(async (url, options = {}) => {
    const u = String(url);
    const method = options.method || 'GET';
    calls.push({ url: u, method, options });

    if (u.includes('/terms/versions')) {
      return jsonResponse({
        success: true,
        versions: { GIKOMART_TERMS_OF_SERVICE: '1.0.0', STORE_OWNER_TERMS: '1.0.0', SELLER_TERMS: '1.0.0', BUYER_TERMS: '1.0.0' },
      });
    }
    if (u.includes('/support-contact')) return jsonResponse({ success: true, support: { phoneLocal: '0776000000' } });

    // Store-creation payment initiation: hands back the invoice + one-time
    // token, matching the real piggyback contract (ownerToken+invoiceId).
    if (u.includes('/payments/initiate-store-plan')) {
      expect(method).toBe('POST');
      return jsonResponse({ success: true, message: 'STK push sent. Check your phone.', invoiceId: 'seller-inv-1', amount: 150, ownerToken: OWNER_TOKEN });
    }

    // The status poll resolves the store: `storeId` present → adopted
    // (saveStoreToken → closeStoreModal → renderMyStore).
    if (u.includes('/payments/status/')) {
      return jsonResponse({ success: true, type: 'store', storeId: STORE._id, status: 'completed', failedCode: null, listingId: null });
    }

    // Store-listing publish (the seller journey's POST target).
    if (u.includes(`/stores/${STORE._id}/listings`)) {
      createdListingCalls.push({ url: u, options, body: options.body ? JSON.parse(options.body) : null });
      listingCountUsed += 1; // ONLY a valid successful publish consumes a slot
      return { ok: true, status: 201, json: async () => ({ success: true, message: 'published', listing: { _id: 'lst-ui-1' } }) };
    }

    // Management panel read: always reports the CURRENT closure-backed count.
    if (u.includes(`/stores/${STORE._id}`)) {
      return jsonResponse({ success: true, store: STORE, listingCount: listingCountUsed });
    }

    if (u.includes('/listings/categories')) {
      return jsonResponse({ success: true, categories: [{ id: 'electronics', name: 'Electronics', icon: '📱' }] });
    }
    if (u.includes('/listings')) return jsonResponse({ success: true, listings: [], total: 0, page: 1, totalPages: 0 });
    return jsonResponse({ success: true });
  }));

  // Fresh seller: NO store token up front. The creation flow must mint it.
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

function fillSellerListingForm() {
  document.getElementById('f-title').value = 'Store Journey Camera';
  document.getElementById('f-category').value = 'electronics';
  document.getElementById('f-condition').value = 'Good';
  document.getElementById('f-price').value = '4000';
  document.getElementById('f-description').value = 'Chained seller-journey listing.';
  document.getElementById('f-seller').value = 'Jane';
  document.getElementById('f-whatsapp').value = '0711111111';
}

beforeEach(() => {
  calls.length = 0;
  createdListingCalls.length = 0;
  listingCountUsed = 2;
});

describe('seller journey — store creation → panel → store-context publish → refreshed count', () => {
  it('chains store creation resolution, the management panel, store-context publish, and the refreshed count', async () => {
    // ── Step 1: open the real Store-creation flow ──────────────────────────
    document.querySelector('[data-view="mystore"]').click();
    // No store yet → the real empty state with its creation CTA.
    await waitFor(() => document.querySelector('#mystoreContent [data-action="open-store-creation"]'));
    document.querySelector('#mystoreContent [data-action="open-store-creation"]').click();

    await waitFor(() => document.getElementById('storeModalOverlay').classList.contains('open'));
    const card = document.getElementById('storeModalCard');
    expect(card.textContent).toContain('Open a Store');

    // Bundle policy: first plan card is selected out of the box.
    const planCards = [...card.querySelectorAll('[data-action="select-store-plan"]')];
    expect(planCards.length).toBeGreaterThanOrEqual(1);
    expect(document.querySelector('#storePlanOptions .boost-option.selected')).toBeTruthy();

    // Complete the real form: plan card + fields + valid M-Pesa number.
    const plans = { starter_weekly: 5, standard_monthly: 10, pro_monthly: 15 };
    const chosenPlan = document.querySelector('#storePlanOptions .boost-option.selected').dataset.plan;
    STORE.listing_limit = plans[chosenPlan];
    document.getElementById('sc-name').value = 'Rig Store';
    document.getElementById('sc-category').value = 'Electronics';
    document.getElementById('sc-description').value = 'Chained seller-journey store.';
    document.getElementById('sc-phone').value = '0720000000';
    document.getElementById('sc-whatsapp').value = '0720000000';
    document.getElementById('sc-phoneNumber').value = '0720000000';

    document.getElementById('storeCreationForm').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

    // ── Step 2: the creation resolution flow adopts the store token ────────
    await waitFor(() => calls.some((c) => c.url.includes('/payments/initiate-store-plan')));
    await waitFor(() => calls.some((c) => c.url.includes('/payments/status/')));
    // Token minted through the app's own mechanism (saveStoreToken during poll).
    await waitFor(() => localStorage.getItem(`gikomart_storeToken:${STORE._id}`) === OWNER_TOKEN);
    expect(localStorage.getItem(`gikomart_storeToken:${STORE._id}`)).toBe(OWNER_TOKEN);

    // The payment-status poll closes the modal and re-renders My Store.
    await waitFor(() => document.getElementById('mystoreContent').textContent.includes('Rig Store'));

    // ── Step 3: the management panel renders with the initial allowance ────
    // Mandated initial state: 2 used of 5 → 3 available (the closure-backed
    // stub starts listingCountUsed = 2; production derives available itself).
    const panelText = document.getElementById('mystoreContent').textContent;
    expect(panelText).toContain(`2 / ${STORE.listing_limit}`);
    expect(panelText).toContain(`listings used (${STORE.listing_limit - 2} remaining)`);
    // Context note uses the counting wording "N listings remaining".
    const addBtn = document.querySelector('[data-action="add-listing"]');
    expect(addBtn, 'the management panel must expose + Add Listing').toBeTruthy();
    expect(addBtn.dataset.storeId).toBe(STORE._id);

    // ── Step 4: open the store-context sell form ───────────────────────────
    addBtn.click();
    await waitFor(() => document.getElementById('view-sell').classList.contains('active'));
    expect(document.getElementById('view-sell').classList.contains('active')).toBe(true);
    const pkg = document.getElementById('packageSection');
    expect(pkg.querySelector('.boost-option')).toBeNull(); // KES package picker replaced
    expect(pkg.textContent).toContain('Covered by your store plan');
    expect(document.getElementById('submitBtn').textContent).toContain('no charge');

    // The context note carries the app's own "N listings remaining" copy;
    // the initial allowance is 3 (2 of the 5 slots already used).
    const availableBefore = Number(pkg.textContent.match(/(\d+)\s+listing[s]?\s+remaining/)?.[1]);
    expect(availableBefore).toBe(STORE.listing_limit - 2);

    // ── Step 5: submit through the REAL form path ──────────────────────────
    fillSellerListingForm();
    document.getElementById('sellForm').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await wait(30);

    // Exactly one POST to the right endpoint with the right credential.
    const posts = createdListingCalls;
    expect(posts).toHaveLength(1);
    expect(posts[0].url).toContain(`/api/stores/${STORE._id}/listings`);
    expect(posts[0].options.headers['X-Store-Owner-Token']).toBe(OWNER_TOKEN);
    expect(posts[0].options.headers['Content-Type']).toContain('application/json');
    // Body shape: listingData + acceptance + website.
    expect(posts[0].body).toBeTruthy();
    expect(posts[0].body.listingData).toBeTruthy();
    expect(posts[0].body.listingData.title).toBe('Store Journey Camera');
    expect(posts[0].body.acceptance).toBeTruthy();
    expect(posts[0].body.acceptance.accepted).toBe(true);
    expect(posts[0].body).toHaveProperty('website');

    // Submission success is rendered in the sell form's status.
    expect(document.querySelector('#view-sell .form-status').textContent).toContain('Published in your store');

    // ── Step 6: the displayed available allowance decreased immediately ────
    const availableAfter = Number(pkg.textContent.match(/(\d+)\s+listing[s]?\s+remaining/)?.[1]);
    expect(availableAfter).toBe(availableBefore - 1);

    // ── Step 7: returning to My Store reads the refresh through renderMyStore
    document.querySelector('.nav-link[data-view="mystore"]').click();
    const refreshedText = await waitFor(() => {
      const t = document.getElementById('mystoreContent').textContent;
      return t.includes(`3 / ${STORE.listing_limit}`) && t.includes(`listings used (${STORE.listing_limit - 3} remaining)`);
    });
    expect(refreshedText, 'My Store must show the updated count after returning').toBe(true);
    const dashNum = document.querySelector('#mystoreContent .dash-num');
    expect(dashNum.textContent).toBe(`3 / ${STORE.listing_limit}`);
  });
});
