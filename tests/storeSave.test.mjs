/* eslint-disable no-undef -- document/window/Event/localStorage are provided by the JSDOM instance constructed below */
// Phase 8 Step 2 — store save/retry button states. No source change: these
// tests exercise the code that already exists in app.js. Harness copied from
// tests/domTerms.test.mjs (manual JSDOM on the node environment, globals copied
// onto globalThis, app.js imported after, DOMContentLoaded dispatched by hand).
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';

const STORE = {
  _id: 'sto-9', name: 'Test Store', category: 'Retail', slug: 'test-store',
  status: 'active', description: 'A test store.', phone: 'test-phone',
  whatsapp: 'test-wa', location: 'Njoro', listing_limit: 10, plan: 'standard_monthly',
  expires_at: new Date(Date.now() + 7 * 86400000).toISOString(),
};

// A store token must exist before app.js is imported so renderMyStore() (called
// during init) loads this store.
const STORE_TOKEN = 'store-owner-token-abc';

// The PUT is gated on a manually-resolved promise so the pending state can be
// observed.
let putGate = null;
let putResponse = { ok: true, status: 200, json: async () => ({ success: true }) };
let storesGetMode = 'success';
const fetchCalls = [];

const tick = () => new Promise((r) => setTimeout(r, 0));
async function waitFor(pred, tries = 200) {
  for (let i = 0; i < tries; i += 1) {
    if (pred()) return true;
    await tick();
  }
  return pred();
}
const putCalls = () => fetchCalls.filter((c) => c.options && c.options.method === 'PUT' && c.url.includes('/stores/'));
const saveBtn = () => document.querySelector('[data-action="save-store-edit"]');

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

  localStorage.setItem('gikomart_storeToken:sto-9', STORE_TOKEN);

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
    if (u.includes('/stores/') && options.method === 'PUT') {
      if (putGate) await putGate;
      return putResponse;
    }
    if (u.includes('/stores/sto-9')) {
      if (storesGetMode === 'fail') return { ok: false, status: 500, json: async () => ({ success: false }) };
      return jsonResponse({ success: true, store: STORE, listingCount: 2 });
    }
    if (u.includes('/listings') && !u.includes('/listings/categories')) return jsonResponse({ success: true, listings: [] });
    return jsonResponse({ success: true });
  }));

  dom.window.addEventListener('error', (e) => console.log('WINDOW-ERROR:', e.error?.stack || e.message));
  await import('../public/assets/js/app.js');
  document.dispatchEvent(new Event('DOMContentLoaded'));
  await new Promise((r) => setTimeout(r, 25));
});

async function openEditForm() {
  // renderMyStore() only runs when the My Store view is activated.
  document.querySelector('.nav-link[data-view="mystore"]').click();
  await waitFor(() => document.querySelector('[data-action="edit-store"]'));
  document.querySelector('[data-action="edit-store"]').click();
  await waitFor(() => saveBtn());
  expect(saveBtn()).toBeTruthy();
}

function fillEdits() {
  document.getElementById('se-name').value = 'Renamed Store';
  document.getElementById('se-description').value = 'New description';
  document.getElementById('se-phone').value = 'test-phone-2';
  document.getElementById('se-whatsapp').value = 'test-wa-2';
  document.getElementById('se-location').value = 'Nakuru';
}

beforeEach(async () => {
  fetchCalls.length = 0;
  putGate = null;
  putResponse = { ok: true, status: 200, json: async () => ({ success: true }) };
  storesGetMode = 'success';
  document.getElementById('toast').textContent = '';
  document.getElementById('storeModalOverlay').classList.remove('open');
  await openEditForm();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Phase 8 Step 2 — store save and retry states', () => {
  it('while the PUT is pending the Save button shows Saving… and is disabled', async () => {
    let release;
    putGate = new Promise((r) => { release = r; });
    fillEdits();
    saveBtn().click();
    await waitFor(() => putCalls().length === 1);

    expect(saveBtn().textContent).toContain('Saving…');
    expect(saveBtn().disabled).toBe(true);

    release();
    await waitFor(() => saveBtn().textContent === 'Saved ✓');
  });

  it('on success the button reads Saved ✓ then reverts to Save Changes and closes after 2000 ms', async () => {
    // Fake timers are installed BEFORE the click so the success path's 2000 ms
    // timer is scheduled on the fake clock and can be advanced deterministically.
    vi.useFakeTimers();
    fillEdits();
    saveBtn().click();
    await vi.advanceTimersByTimeAsync(0);

    expect(saveBtn().textContent).toBe('Saved ✓');
    expect(saveBtn().disabled).toBe(false);
    expect(document.getElementById('toast').textContent).toContain('Store updated');

    await vi.advanceTimersByTimeAsync(2000);
    expect(saveBtn().textContent).toBe('Save Changes');
    expect(document.getElementById('storeModalOverlay').classList.contains('open')).toBe(false);
  });

  it('on a failing response the button reads Retry, keeps the modal open and the typed values, and toasts the 500 message', async () => {
    putResponse = { ok: false, status: 500, json: async () => ({ success: false, error: 'x' }) };
    fillEdits();
    saveBtn().click();
    await waitFor(() => saveBtn().textContent === 'Retry');

    expect(saveBtn().textContent).toBe('Retry');
    expect(saveBtn().disabled).toBe(false);
    expect(document.getElementById('storeModalOverlay').classList.contains('open')).toBe(true);
    expect(document.getElementById('se-name').value).toBe('Renamed Store');
    expect(document.getElementById('se-description').value).toBe('New description');
    expect(document.getElementById('se-phone').value).toBe('test-phone-2');
    expect(document.getElementById('se-whatsapp').value).toBe('test-wa-2');
    expect(document.getElementById('se-location').value).toBe('Nakuru');
    expect(document.getElementById('toast').textContent).toBe('⚠️ Something went wrong on our end. Please try again in a minute.');
  });

  it('clicking Retry after a failure sends a second PUT with the store owner token header', async () => {
    putResponse = { ok: false, status: 500, json: async () => ({ success: false, error: 'x' }) };
    fillEdits();
    saveBtn().click();
    await waitFor(() => putCalls().length === 1);
    await waitFor(() => saveBtn().textContent === 'Retry');
    expect(saveBtn().textContent).toBe('Retry');
    expect(putCalls()).toHaveLength(1);

    saveBtn().click();
    await waitFor(() => putCalls().length === 2);
    expect(putCalls()).toHaveLength(2);
    expect(putCalls()[1].url).toContain('/api/stores/sto-9');
    expect(putCalls()[1].options.headers['X-Store-Owner-Token']).toBe(STORE_TOKEN);
  });

  it('a rejected fetch shows the offline message and leaves the button as Retry', async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (url, options = {}) => {
      if (String(url).includes('/stores/') && options.method === 'PUT') {
        throw new TypeError('Failed to fetch');
      }
      return realFetch(url, options);
    });
    try {
      fillEdits();
      saveBtn().click();
      await waitFor(() => saveBtn().textContent === 'Retry');
      expect(saveBtn().textContent).toBe('Retry');
      expect(document.getElementById('toast').textContent).toBe("📡 Couldn't connect. Check your internet and try again.");
      expect(saveBtn().disabled).toBe(false);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
