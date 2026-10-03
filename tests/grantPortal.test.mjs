/* eslint-disable no-undef -- document/window/Event come from the JSDOM instance built below */
// Drives the REAL public/assets/js/admin.js against the REAL
// public/admin/index.html with a stubbed fetch, mirroring tests/adminPortal.test.mjs
// (which cannot be imported without editing it).
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

const fetchCalls = [];
let fetchHandler;

function json(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

const LOGIN_URL = '/api/admin/login';
const METRICS_URL = '/api/admin/metrics';
const PREVIEW_URL = '/api/admin/grant-preview';
const GRANT_URL = '/api/admin/grant-free-access';

function previewPayment(overrides = {}) {
  return {
    id: 'pay-1',
    type: 'listing',
    package: 'standard',
    storePlan: null,
    amount: 50,
    createdAt: '2026-10-02T12:00:00.000Z',
    title: 'Textbook for sale',
    storeName: null,
    phoneMasked: '2547***01',
    ...overrides,
  };
}

function defaultHandler(url) {
  if (url.includes(LOGIN_URL)) return json({ success: true, token: 'tok-abc' });
  if (url.includes(METRICS_URL)) return json({ success: true, listings: {}, stores: {}, payments: {}, revenue: {}, reports: {}, blocks: {} });
  if (url.includes(PREVIEW_URL)) return json({ success: true, payment: previewPayment() });
  if (url.includes(GRANT_URL)) return json({ success: true, message: 'Free access granted', paymentId: 'pay-1', resource: { type: 'listing', id: 'lst-1' } });
  return json({ success: false }, 404);
}

beforeAll(async () => {
  const { JSDOM, VirtualConsole } = await import('jsdom');
  const { readFileSync } = await import('node:fs');
  const path = await import('node:path');
  const html = readFileSync(path.join(process.cwd(), 'public', 'admin', 'index.html'), 'utf8');
  const virtualConsole = new VirtualConsole();
  virtualConsole.forwardTo(console);
  const dom = new JSDOM(html, { url: 'https://gikomart.test/', virtualConsole });

  globalThis.document = dom.window.document;
  globalThis.window = dom.window;
  globalThis.Event = dom.window.Event;
  globalThis.localStorage = dom.window.localStorage;
  globalThis.sessionStorage = dom.window.sessionStorage;

  vi.stubGlobal('fetch', vi.fn(async (url, options = {}) => {
    fetchCalls.push({ url: String(url), options });
    return fetchHandler(String(url), options);
  }));

  await import('../public/assets/js/admin.js');
});

function tick(ms = 40) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function submitLogin(key, code) {
  document.getElementById('adminKey').value = key;
  document.getElementById('totpCode').value = code;
  document.getElementById('loginForm').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
}

async function signIn() {
  submitLogin('test-key', '123456');
  await tick();
}

async function openGrantTab(handler) {
  await signIn();
  if (handler) fetchHandler = handler;
  document.querySelector('.tab[data-view="grant"]').click();
  await tick();
}

beforeEach(() => {
  const signOutBtn = document.getElementById('signOutBtn');
  if (!signOutBtn.hidden) signOutBtn.click();
  fetchCalls.length = 0;
  fetchHandler = defaultHandler;
});

function fillInvoice(value) {
  document.getElementById('grantInvoiceId').value = value;
}

describe('Grant tab — preview gating', () => {
  it('renders the preview and grant buttons with the grant button disabled initially', async () => {
    await openGrantTab();

    const previewBtn = document.getElementById('grantPreviewBtn');
    const grantBtn = document.getElementById('grantSubmit');
    expect(previewBtn).not.toBeNull();
    expect(grantBtn).not.toBeNull();
    expect(grantBtn.disabled).toBe(true);
  });

  it('enables the grant button after a successful preview and disables it again when an input changes', async () => {
    await openGrantTab();
    fillInvoice('INV-GRANT-1');

    document.getElementById('grantPreviewBtn').click();
    await tick();

    expect(document.getElementById('grantSubmit').disabled).toBe(false);

    // Editing any input must invalidate the preview.
    document.getElementById('grantInvoiceId').value = 'INV-CHANGED';
    document.getElementById('grantInvoiceId').dispatchEvent(new Event('input', { bubbles: true }));
    expect(document.getElementById('grantSubmit').disabled).toBe(true);
  });

  it('shows the preview text with textContent and creates no <b> element', async () => {
    await openGrantTab((url) => {
      if (url.includes(PREVIEW_URL)) return json({ success: true, payment: previewPayment({ title: '<b>x</b>' }) });
      return defaultHandler(url);
    });
    fillInvoice('INV-GRANT-1');

    document.getElementById('grantPreviewBtn').click();
    await tick();

    const msg = document.getElementById('grantPreviewMsg');
    expect(msg).not.toBeNull();
    expect(msg.textContent).toContain('Will grant:');
    expect(document.querySelector('#viewBody b')).toBeNull();
    expect(msg.textContent).toContain('<b>x</b>');
  });

  it('sends only paymentId equal to the previewed id when granting', async () => {
    await openGrantTab();
    fillInvoice('INV-GRANT-1');

    document.getElementById('grantPreviewBtn').click();
    await tick();
    fetchCalls.length = 0;

    document.getElementById('grantSubmit').click();
    await tick();

    const grantCall = fetchCalls.find((c) => c.url.includes(GRANT_URL));
    expect(grantCall).toBeTruthy();
    expect(JSON.parse(grantCall.options.body)).toEqual({ paymentId: 'pay-1' });
  });

  it('keeps the grant button disabled when the preview fails', async () => {
    await openGrantTab((url) => {
      if (url.includes(PREVIEW_URL)) return json({ success: false, error: 'No matching pending payment found' }, 404);
      return defaultHandler(url);
    });
    fillInvoice('INV-NOPE');

    document.getElementById('grantPreviewBtn').click();
    await tick();

    expect(document.getElementById('grantSubmit').disabled).toBe(true);
  });
});
