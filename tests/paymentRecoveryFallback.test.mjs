// Payment-recovery fallback: when GET /api/support-contact is unavailable the
// still-processing copy must degrade gracefully to the reference-only wording
// instead of throwing or showing a broken message. Lives in its own file so
// the app.js module registry is fresh — the successful-path cache in
// tests/paymentRecovery.test.mjs must not leak into this scenario.

/* eslint-disable no-undef -- document/window/Event/localStorage are provided by the JSDOM instance constructed below */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

const INVOICE_ID = 'INV-FALLBACK-1';
const OWNER_TOKEN = 'owner-token-fallback';
const statusPayload = { success: true, status: 'pending' };

beforeAll(async () => {
  process.env.ADMIN_KEY = 'test-admin-key';
  process.env.INTASEND_WEBHOOK_CHALLENGE = 'test-challenge';
  process.env.ADMIN_SESSION_SECRET = 'test-session-secret';

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

  const jsonResponse = (body) => ({ ok: true, status: 200, json: async () => body });
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    const u = String(url);
    if (u.includes('/terms/versions')) {
      return jsonResponse({ success: true, versions: { GIKOMART_TERMS_OF_SERVICE: '1.0.0', STORE_OWNER_TERMS: '1.0.0', SELLER_TERMS: '1.0.0', BUYER_TERMS: '1.0.0' } });
    }
    if (u.includes('/payments/initiate-listing')) {
      return jsonResponse({ success: true, message: 'STK push sent. Check your phone.', amount: 50, invoiceId: INVOICE_ID, ownerToken: OWNER_TOKEN });
    }
    if (u.includes('/payments/status/')) return jsonResponse(statusPayload);
    if (u.includes('/listings/categories')) return jsonResponse({ success: true, categories: [{ id: 'electronics', name: 'Electronics', icon: '📱', legacyNames: [] }] });
    // /support-contact deliberately unreachable in this scenario (no route).
    if (u.includes('/listings')) return jsonResponse({ success: true, listings: [], total: 0, page: 1, totalPages: 0 });
    return { ok: false, status: 404, json: async () => ({ success: false }) };
  }));

  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

  await import('../public/assets/js/app.js');
  document.dispatchEvent(new Event('DOMContentLoaded'));
  await vi.advanceTimersByTimeAsync(0);
});

afterAll(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('P3 — payment recovery degrades gracefully without support-contact metadata', () => {
  it('manual check with the endpoint unreachable shows the reference-only copy (no crash, no number)', async () => {
    document.getElementById('f-title').value = 'Fallback Widget';
    document.getElementById('f-category').value = 'electronics';
    document.getElementById('f-condition').value = 'Excellent';
    document.getElementById('f-price').value = '500';
    document.getElementById('f-description').value = 'Exercises the recovery fallback.';
    document.getElementById('f-seller').value = 'Tester';
    document.getElementById('f-whatsapp').value = '0700000000';
    document.getElementById('f-location').value = 'Njoro';
    document.getElementById('sellForm').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await vi.advanceTimersByTimeAsync(0);

    // Exhaust the automatic window (2+4+8+16+32 = 62s) into Recovery, then
    // run the single manual check against a still-pending payment.
    await vi.advanceTimersByTimeAsync(62000);
    const statusEl = document.getElementById('formStatus');
    const manualBtn = statusEl.querySelector('[data-manual-check]');
    expect(manualBtn).toBeTruthy();
    manualBtn.click();
    await vi.advanceTimersByTimeAsync(0);

    expect(statusEl.textContent).toBe(`Still processing. Please contact support with reference: ${INVOICE_ID}.`);
    expect(statusEl.className).toContain('error');
    expect(statusEl.textContent).not.toContain('WhatsApp');
  });
});
