/* eslint-disable no-undef -- document/localStorage/Event/window come from the JSDOM instance built in bootApp */
// Cross-device grant continuation — drives the REAL app.js against the REAL
// public/index.html. Each test boots a FRESH JSDOM at its own URL, because the
// continuation capture runs once at script-parse time and must observe the
// exact URL under test.
//
// Harness notes:
// - One fetch stub is installed in beforeAll and DELEGATES to the current
//   boot's handler (currentHandler), recording into callsLog. Re-stubbing per
//   boot loses calls to vitest's global-stub management, so the log lives at
//   module scope and is reset on every boot.
// - A still-pending grant keeps its backoff pollers alive across boots (real
//   Node timers), so every status-call assertion filters by the claim id under
//   test; a stale poller for a previous claim must never satisfy one of these.
import { describe, it, expect, beforeAll, vi } from 'vitest';

const jsonResponse = (body, status = 200) => ({ ok: true, status, json: async () => body });

const origin = 'https://gikomart.test';

let currentHandler = null;
const callsLog = [];

const tick = (ms = 25) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, timeoutMs = 3000, label = 'condition') {
  const start = Date.now();
  for (;;) {
    if (fn()) return;
    if (Date.now() - start > timeoutMs) throw new Error(`waitFor timed out: ${label}`);
    await tick();
  }
}

async function bootApp(url, handler) {
  vi.resetModules();
  currentHandler = handler;
  callsLog.length = 0;

  const { JSDOM, VirtualConsole } = await import('jsdom');
  const { readFileSync } = await import('node:fs');
  const path = await import('node:path');
  const html = readFileSync(path.join(process.cwd(), 'public', 'index.html'), 'utf8');
  const virtualConsole = new VirtualConsole();
  virtualConsole.forwardTo(console);
  const dom = new JSDOM(html, { url, virtualConsole });

  globalThis.document = dom.window.document;
  globalThis.window = dom.window;
  globalThis.Event = dom.window.Event;
  globalThis.localStorage = dom.window.localStorage;

  await import('../public/assets/js/app.js');
  document.dispatchEvent(new Event('DOMContentLoaded'));
  await tick(10);
  return {
    dom,
    card: () => document.getElementById('grantModalCard'),
    overlayOpen: () => document.getElementById('grantModalOverlay').classList.contains('open'),
    statusCalls: (claimId) => callsLog.filter((c) => c.url.includes(`/api/grants/status/${claimId}`)),
  };
}

beforeAll(() => {
  vi.stubGlobal('fetch', vi.fn(async (u, options = {}) => {
    const target = String(u);
    callsLog.push({ url: target, method: (options.method || 'GET').toUpperCase(), options });
    if (!currentHandler) return { ok: false, status: 599, json: async () => ({ success: false }) };
    return currentHandler(target, options);
  }));
});

// Shared endpoints: terms + listings. Individual tests supply the status answer.
const baseHandler = (target) => {
  if (target.includes('/terms/versions')) {
    return jsonResponse({ success: true, versions: { GIKOMART_TERMS_OF_SERVICE: '1.0.0', STORE_OWNER_TERMS: '1.0.0', SELLER_TERMS: '1.0.0', BUYER_TERMS: '1.0.0' } });
  }
  if (target.includes('/listings')) return jsonResponse({ success: true, listings: [] });
  return null;
};

function withStatus(statusResponse) {
  return (target) => {
    if (target.includes('/api/grants/status/')) return statusResponse();
    return baseHandler(target);
  };
}

describe('Cross-device grant continuation — URL-hash boot', () => {
  it('restores an APPROVED grant from the continuation link and scrubs the URL', async () => {
    const app = await bootApp(`${origin}/#grant=grant-9/tok-cont-123`,
      withStatus(() => jsonResponse({ success: true, status: 'approved', type: 'listing' })));
    const card = app.card();

    // The approved-grant redemption UI is shown — not a request form.
    // Provisioning has NOT happened: that requires the explicit
    // "Publish with Free Grant" submit, never the link itself.
    await waitFor(() => card.textContent.includes('Your free grant was approved'), 3000, 'approved card');
    expect(card.querySelector('#grantRedeemForm')).not.toBeNull();
    expect(card.querySelector('#grantRequestForm')).toBeNull();

    // The token was adopted into the existing grant-token storage and is used
    // as the X-Grant-Token header — the same mechanism as the seller's browser.
    expect(localStorage.getItem('gikomart_grantToken:grant-9')).toBe('tok-cont-123');
    const statusCalls = app.statusCalls('grant-9');
    expect(statusCalls.length).toBeGreaterThan(0);
    for (const call of statusCalls) {
      expect(call.options.headers['X-Grant-Token']).toBe('tok-cont-123');
      expect(call.url).not.toContain('tok-cont-123'); // header, never the URL
    }

    // The bearer token never appears in page content.
    expect(card.textContent).not.toContain('tok-cont-123');

    // Sensitive parameters were removed from the visible URL via the History API.
    expect(app.dom.window.location.hash).toBe('');
    expect(app.dom.window.location.href).toBe(origin + '/');
  });

  it('lands a PENDING continuation on the submitted/pending state', async () => {
    const app = await bootApp(`${origin}/#grant=grant-8/tok-cont-456`,
      withStatus(() => jsonResponse({ success: true, status: 'pending', type: 'listing' })));
    await waitFor(() => app.card().textContent.includes('Request submitted ✓'), 3000, 'pending card');
    expect(app.card().textContent).toContain('Pending admin approval');
    expect(localStorage.getItem('gikomart_grantToken:grant-8')).toBe('tok-cont-456');
    expect(app.dom.window.location.hash).toBe('');
  });

  it('a malformed continuation (missing token) restores nothing and leaves no state', async () => {
    const app = await bootApp(`${origin}/#grant=grant-7/`,
      withStatus(() => jsonResponse({ success: true, status: 'approved', type: 'listing' })));
    await tick(80);
    expect(app.statusCalls('grant-7')).toHaveLength(0); // never polled — no token, no authorization
    expect(localStorage.getItem('gikomart_grantToken:grant-7')).toBeNull();
    expect(app.dom.window.location.hash).toBe(''); // still scrubbed
    expect(app.overlayOpen()).toBe(false);
    expect(app.card().querySelector('#grantRedeemForm')).toBeNull();
  });

  it('a token-less visit without a grant hash is a no-op', async () => {
    const app = await bootApp(`${origin}/`,
      withStatus(() => jsonResponse({ success: true, status: 'pending', type: 'listing' })));
    await tick(80);
    expect(app.statusCalls('grant-8')).toHaveLength(0);
    expect(app.dom.window.location.hash).toBe('');
  });

  it('a WRONG token fails server-side and never reaches the redemption form', async () => {
    const app = await bootApp(`${origin}/#grant=grant-6/tok-wrong`,
      withStatus(() => ({ ok: false, status: 401, json: async () => ({ success: false, error: 'Invalid grant token' }) })));
    await waitFor(() => app.statusCalls('grant-6').length > 0, 3000, 'status call made');
    expect(app.card().querySelector('#grantRedeemForm')).toBeNull();
  });

  it('a REJECTED continuation shows the terminal state and clears the stored claim', async () => {
    const app = await bootApp(`${origin}/#grant=grant-5/tok-cont-789`,
      withStatus(() => jsonResponse({ success: true, status: 'rejected', type: 'listing' })));
    await waitFor(() => app.card().textContent.includes('Grant request not approved'), 3000, 'rejected card');
    expect(localStorage.getItem('gikomart_grantToken:grant-5')).toBeNull();
    expect(app.dom.window.location.hash).toBe('');
  });

  it('a bare claim id without any token restores nothing', async () => {
    let statusEndpointHit = false;
    await bootApp(`${origin}/#grant=grant-4`, (target) => {
      if (target.includes('/api/grants/status/grant-4')) {
        statusEndpointHit = true;
        return jsonResponse({ success: true, status: 'approved', type: 'listing' });
      }
      return baseHandler(target);
    });
    await tick(80);
    expect(statusEndpointHit).toBe(false); // must never poll without a token
    expect(localStorage.getItem('gikomart_grantToken:grant-4')).toBeNull();
  });
});
