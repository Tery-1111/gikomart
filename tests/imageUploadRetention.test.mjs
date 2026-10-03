/* eslint-disable no-undef -- document/window/Event/localStorage/FormData/FileReader are provided by the JSDOM instance constructed below */
// Phase 8b Step 1 — a failed replacement photo upload must restore the photo
// that was already confirmed (its URL and its preview), and tell the seller the
// previous photo was kept. The first case observes the exact images array
// handleSubmit sends to /api/payments/initiate-listing.
//
// Harness copied from tests/domTerms.test.mjs (manual JSDOM on the node
// environment, globals copied onto globalThis, app.js imported after,
// DOMContentLoaded dispatched by hand), with three test-only adaptations:
//   * each test boots a FRESH JSDOM and a FRESH app.js module (vi.resetModules
//     plus a cache-busting import query), because app.js keeps uploadedImageUrl
//     in module state — sharing one module lets a prior test's state bleed in.
//   * FileReader is stubbed to fire synchronously (jsdom's real reader resolves
//     after the fetch, which makes the picked preview race the failure restore).
//   * fake timers drive fetchUploadWithRetry's backoff instantly instead of
//     waiting through its real 1s/2s/4s retry delays. app.js is unchanged.
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';

const FIRST_URL = 'https://cdn.example.test/photo-first.png';
const SECOND_URL = 'https://cdn.example.test/photo-second.png';

// Responses /api/upload gives, consumed in order; the last one repeats for any
// retry attempts the client makes (fetchUploadWithRetry retries 5xx/rejects).
let uploadQueue = [];
let lastUpload = null;
const fetchCalls = [];

const previewSrc = () => document.getElementById('imagePreviewImg').getAttribute('src');
const statusText = () => document.getElementById('imageUploadStatus').textContent;

// Under fake timers, advance the clock and flush the promise chain it gates.
const flush = async (ms = 0) => { await vi.advanceTimersByTimeAsync(ms); };

const uploadOk = (url) => ({ ok: true, status: 200, json: async () => ({ url }) });
const upload500 = () => ({ ok: false, status: 500, json: async () => ({}), text: async () => '' });
const uploadReject = () => { throw new Error('network down'); };

function queueUploads(...responses) {
  uploadQueue = responses.slice();
  lastUpload = responses[responses.length - 1];
}

// Dispatch a file pick. The (stubbed, synchronous) FileReader renders the
// preview from the file in the same tick.
function pickPhoto() {
  const input = document.getElementById('f-image');
  const file = new window.File([new Uint8Array([1, 2, 3])], 'photo.png', { type: 'image/png' });
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  input.dispatchEvent(new Event('change'));
}

function fillSellForm() {
  document.getElementById('f-title').value = 'Test listing';
  document.getElementById('f-price').value = '1000';
  document.getElementById('f-description').value = 'A description.';
  document.getElementById('f-seller').value = 'Jane';
  document.getElementById('f-whatsapp').value = '0700000000';
  document.getElementById('f-location').value = 'Njoro';
  document.getElementById('listingPhone').value = '0700000000';
}

// Submit the sell form and return the parsed body of the payment request.
async function submitSellForm() {
  fillSellForm();
  fetchCalls.length = 0;
  document.getElementById('sellForm').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await flush(0);
  const initiate = fetchCalls.find((c) => c.url.includes('/payments/initiate-listing'));
  expect(initiate, 'the sell form submit must reach /payments/initiate-listing').toBeTruthy();
  return JSON.parse(initiate.options.body);
}

let html = '';
beforeAll(async () => {
  const { readFileSync } = await import('node:fs');
  const path = await import('node:path');
  html = readFileSync(path.join(process.cwd(), 'public', 'index.html'), 'utf8');
});

afterEach(() => {
  vi.useRealTimers();
});

// Boot a fresh app instance against a fresh DOM, then switch to fake timers.
async function bootApp() {
  vi.useRealTimers();
  vi.resetModules();
  const { JSDOM, VirtualConsole } = await import('jsdom');
  const virtualConsole = new VirtualConsole();
  virtualConsole.forwardTo(console);
  const dom = new JSDOM(html, { url: 'https://gikomart.test/', virtualConsole });

  globalThis.document = dom.window.document;
  globalThis.window = dom.window;
  globalThis.Event = dom.window.Event;
  globalThis.localStorage = dom.window.localStorage;
  globalThis.FormData = dom.window.FormData;
  globalThis.File = dom.window.File;
  let readerCount = 0;
  class SyncFileReader {
    readAsDataURL() {
      readerCount += 1;
      this.result = `data:image/png;base64,PICK${readerCount}`;
      if (this.onload) this.onload({ target: { result: this.result } });
    }
  }
  globalThis.FileReader = SyncFileReader;
  dom.window.open = vi.fn();

  uploadQueue = [];
  lastUpload = null;
  fetchCalls.length = 0;

  const jsonResponse = (body) => ({ ok: true, status: 200, json: async () => body });
  vi.stubGlobal('fetch', vi.fn(async (url, options = {}) => {
    const u = String(url);
    fetchCalls.push({ url: u, options });
    if (u.includes('/terms/versions')) return jsonResponse({ success: true, versions: {} });
    if (u.includes('/payments/initiate-listing')) {
      return jsonResponse({ success: true, amount: 50, invoiceId: 'INV-LST-1', ownerToken: 'tok-lst' });
    }
    if (u.includes('/payments/status/')) return jsonResponse({ success: true, listingId: 'lst-new' });
    if (u.includes('/listings')) return jsonResponse({ success: true, listings: [] });
    if (u.includes('/upload')) {
      const next = uploadQueue.length ? uploadQueue.shift() : lastUpload;
      return typeof next === 'function' ? next() : next;
    }
    return { ok: false, status: 404, json: async () => ({ success: false }) };
  }));

  dom.window.addEventListener('error', (e) => console.log('WINDOW-ERROR:', e.error?.stack || e.message));
  // vi.resetModules() clears the module registry, so this import re-evaluates
  // app.js fresh each test. (A cache-busting ?query cannot be used here: vite
  // rejects a variable dynamic-import specifier with a query string.)
  await import('../public/assets/js/app.js');
  document.dispatchEvent(new Event('DOMContentLoaded'));
  await new Promise((r) => setTimeout(r, 25));

  // Now that init has settled on real timers, drive uploads on fake ones.
  vi.useFakeTimers();
}

beforeEach(bootApp);

describe('Image upload retention (Phase 8b Step 1)', () => {
  it('keeps the first photo (preview, status, and submitted image) when a replacement fails with 500', async () => {
    queueUploads(uploadOk(FIRST_URL));
    pickPhoto();
    await flush(0);
    const firstPreview = previewSrc();
    expect(firstPreview).toBeTruthy();
    expect(statusText()).toBe('✅ Photo uploaded');

    // The replacement fails with a 500 (retried four times, then surfaced); its
    // preview differs, so a restore is observable.
    queueUploads(upload500());
    pickPhoto();
    await flush(7000);

    expect(previewSrc()).toBe(firstPreview);
    expect(statusText()).toContain('Your previous photo was kept.');

    const body = await submitSellForm();
    expect(body.listingData.images).toEqual([FIRST_URL]);
  });

  it('a failing first upload with no previous photo submits no image and omits the kept sentence', async () => {
    queueUploads(upload500());
    pickPhoto();
    await flush(7000);

    expect(statusText()).not.toContain('Your previous photo was kept.');
    expect(statusText()).toContain('listing will be posted without it');

    const body = await submitSellForm();
    expect(body.listingData.images).toEqual([]);
  });

  it('restores the previous photo when the replacement fetch rejects (network error)', async () => {
    queueUploads(uploadOk(FIRST_URL));
    pickPhoto();
    await flush(0);
    const firstPreview = previewSrc();
    expect(firstPreview).toBeTruthy();

    queueUploads(uploadReject);
    pickPhoto();
    await flush(7000);

    expect(previewSrc()).toBe(firstPreview);
    expect(statusText()).toContain('Your previous photo was kept.');
  });

  it('a successful replacement replaces the first URL with the second', async () => {
    queueUploads(uploadOk(FIRST_URL));
    pickPhoto();
    await flush(0);
    const firstPreview = previewSrc();

    queueUploads(uploadOk(SECOND_URL));
    pickPhoto();
    await flush(0);

    expect(previewSrc()).not.toBe(firstPreview);
    expect(statusText()).not.toContain('Your previous photo was kept.');

    const body = await submitSellForm();
    expect(body.listingData.images).toEqual([SECOND_URL]);
  });
});
