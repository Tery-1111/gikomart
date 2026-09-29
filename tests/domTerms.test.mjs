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
import { describe, it, expect, beforeAll, vi } from 'vitest';

const V1 = { GIKOMART_TERMS_OF_SERVICE: '1.0.0', STORE_OWNER_TERMS: '1.0.0', SELLER_TERMS: '1.0.0', BUYER_TERMS: '1.0.0' };
const V2 = { GIKOMART_TERMS_OF_SERVICE: '1.0.1', STORE_OWNER_TERMS: '1.0.1', SELLER_TERMS: '1.0.1', BUYER_TERMS: '1.0.1' };

// Whatever this holds when /terms/versions is called is what the server "is".
let nextVersions = V1;
const fetchCalls = [];

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

  const jsonResponse = (body) => ({ ok: true, status: 200, json: async () => body });
  vi.stubGlobal('fetch', vi.fn(async (url, options = {}) => {
    const u = String(url);
    fetchCalls.push({ url: u, options });
    if (u.includes('/terms/versions')) return jsonResponse({ success: true, versions: nextVersions });
    if (u.includes('/payments/initiate-store-plan')) {
      return jsonResponse({ success: true, message: 'STK push sent. Check your phone.', amount: 150, invoiceId: 'INV-STG-1', ownerToken: 'tok-abc' });
    }
    if (u.includes('/payments/status/')) return jsonResponse({ success: true, storeId: 'sto-9' });
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
