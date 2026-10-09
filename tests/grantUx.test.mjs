/* eslint-disable no-undef -- document/localStorage/Event/window come from the JSDOM instance built below */
// Free Grant seller UX states — drives the REAL app.js against the REAL
// public/index.html (manual JSDOM, same pattern as domTerms.test.mjs), with the
// grant endpoints stubbed so each state transition is observable:
//   idle → submitting → submitted/pending → approved → redeem
//                                      → rejected
//                                → failed (form preserved)
//                                → reload (resume banner)
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';

const jsonResponse = (body, status = 200) => ({ ok: true, status, json: async () => body });

// What each grant endpoint answers. Individual tests override these.
let grantSubmitResult = () => jsonResponse({
  success: true, claimId: 'grant-1', claimToken: 'tok-abc', status: 'pending', type: 'listing',
}, 201);
// When set, POST /api/grants returns this pending promise (deferred submit).
let grantSubmitDeferred = null;
let grantSubmitRelease = null;
let grantStatusResult = () => jsonResponse({ success: true, status: 'pending', type: 'listing' });
const calls = [];

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

  vi.stubGlobal('fetch', vi.fn(async (url, options = {}) => {
    const u = String(url);
    const method = (options.method || 'GET').toUpperCase();
    calls.push({ url: u, method, options });
    if (u.includes('/terms/versions')) {
      return jsonResponse({ success: true, versions: { GIKOMART_TERMS_OF_SERVICE: '1.0.0', STORE_OWNER_TERMS: '1.0.0', SELLER_TERMS: '1.0.0', BUYER_TERMS: '1.0.0' } });
    }
    if (u.includes('/listings') && !u.includes('/listings/categories')) return jsonResponse({ success: true, listings: [] });
    if (u.includes('/api/grants/status/')) return grantStatusResult();
    if (u.includes('/api/grants') && method === 'POST') {
      if (grantSubmitDeferred) return grantSubmitDeferred;
      return grantSubmitResult();
    }
    return { ok: false, status: 404, json: async () => ({ success: false }) };
  }));

  await import('../public/assets/js/app.js');
  document.dispatchEvent(new Event('DOMContentLoaded'));
  await new Promise((r) => setTimeout(r, 25));
});

function openGrantModal() {
  const trigger = document.querySelector('[data-action="open-grant-modal"]');
  expect(trigger, 'the Free Grant entry point must exist').not.toBeNull();
  trigger.click();
  return document.getElementById('grantModalCard');
}

// Fill the request form and submit it through the real delegated listener.
async function submitRequest() {
  const card = openGrantModal();
  card.querySelector('#gr-whatsapp').value = '0712345678';
  card.querySelector('#grantRequestForm').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await new Promise((r) => setTimeout(r, 10));
  return card;
}

function closeGrantModalIfOpen() {
  const close = document.querySelector('#grantModalCard [data-action="close-grant-modal"]');
  if (close) close.click();
}

// JSDOM has no navigator.clipboard, so app.js uses the execCommand fallback in
// these tests. For copy-path assertions, swap the global navigator for one
// that captures writeText (the primary browser path), and restore it after.
let restoreNavigator = null;
function stubClipboardCapture(capture) {
  const desc = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', {
    value: { clipboard: { writeText: async (text) => { capture.text = text; } } },
    configurable: true,
    writable: true,
  });
  restoreNavigator = () => {
    if (desc) Object.defineProperty(globalThis, 'navigator', desc);
    else delete globalThis.navigator;
    restoreNavigator = null;
  };
}

beforeEach(() => {
  calls.length = 0;
  grantSubmitDeferred = null;
  grantSubmitRelease = null;
  grantSubmitResult = () => jsonResponse({ success: true, claimId: 'grant-1', claimToken: 'tok-abc', status: 'pending', type: 'listing' }, 201);
  grantStatusResult = () => jsonResponse({ success: true, status: 'pending', type: 'listing' });
  localStorage.clear();
});

afterEach(() => {
  closeGrantModalIfOpen();
});

describe('Free Grant request — submitted/pending state', () => {
  it('shows the submitted state with status, requested details, and both actions', async () => {
    const card = await submitRequest();
    await new Promise((r) => setTimeout(r, 10));

    expect(card.textContent).toContain('Request submitted ✓');
    expect(card.textContent).toContain('has been sent to the GikoMart admin for review');
    expect(card.textContent).toContain('Pending admin approval');
    // Submitted ≠ Approved must be explicit.
    expect(card.textContent).toContain('not approved yet');
    expect(card.textContent).toContain('do not need to make a payment');
    // What was requested (own number, shown as entered — the seller UI does not mask).
    expect(card.textContent).toContain('listing package');
    expect(card.textContent).toContain('0712345678');
    // Both actions.
    expect(card.querySelector('#grCheckBtn')).not.toBeNull();
    expect(card.querySelector('[data-action="close-grant-modal"]')).not.toBeNull();
    // The request form is gone, so the seller cannot resubmit from here.
    expect(card.querySelector('#grantRequestForm')).toBeNull();
    // The claim token is stored for this browser only, never shown in the UI.
    expect(localStorage.getItem('gikomart_grantToken:grant-1')).toBe('tok-abc');
    expect(card.textContent).not.toContain('tok-abc');
  });

  it('sends the existing payload and endpoint, unchanged', async () => {
    await submitRequest();
    await new Promise((r) => setTimeout(r, 10));

    const posts = calls.filter((c) => c.url.includes('/api/grants') && c.method === 'POST');
    expect(posts).toHaveLength(1);
    expect(JSON.parse(posts[0].options.body)).toEqual({
      type: 'listing', package: 'quick', whatsapp: '0712345678', website: '',
    });
  });

  it('shows a pending message on a manual status check and keeps waiting', async () => {
    const card = await submitRequest();
    await new Promise((r) => setTimeout(r, 10));

    const checks = calls.filter((c) => c.url.includes('/api/grants/status/')).length;
    card.querySelector('#grCheckBtn').click();
    await new Promise((r) => setTimeout(r, 10));

    expect(card.querySelector('#grPendingStatus').textContent).toContain('Still pending admin approval');
    expect(calls.filter((c) => c.url.includes('/api/grants/status/')).length).toBeGreaterThan(checks);
  });

  it('does not expose the claim token in the status request URL', async () => {
    await submitRequest();
    await new Promise((r) => setTimeout(r, 10));
    const statusCalls = calls.filter((c) => c.url.includes('/api/grants/status/'));
    expect(statusCalls.length).toBeGreaterThan(0);
    for (const call of statusCalls) {
      expect(call.url).not.toContain('tok-abc');
      // The token travels in the header, as the backend expects.
      expect(call.options.headers['X-Grant-Token']).toBe('tok-abc');
    }
  });

  it("'Copy WhatsApp message' copies request details, number and the private #grant= link in ONE action", async () => {
    await submitRequest();
    await new Promise((r) => setTimeout(r, 10));

    const card = document.getElementById('grantModalCard');
    const waBtn = card.querySelector('#grWhatsAppBtn');
    expect(waBtn).not.toBeNull();

    // The submit itself was a POST; the handoff must add no further requests.
    const postsBeforeCopy = calls.filter((c) => c.method === 'POST').length;
    const capture = {};
    stubClipboardCapture(capture);
    try {
      waBtn.click();
      await new Promise((r) => setTimeout(r, 25));
    } finally {
      restoreNavigator();
    }
    const copied = capture.text;

    // One action, no intermediate steps: the message is already on the clipboard.
    expect(copied).toBeTruthy();
    expect(copied).toContain('Hi! I requested a GikoMart Free Grant');
    expect(copied).toContain('Request: Quick Sale (24h) — listing package');
    expect(copied).toContain('My WhatsApp: 0712345678');
    // The private credential travels INSIDE the copied message as a hash
    // fragment — exactly the format app.js parses on the other device.
    expect(copied).toContain(`${window.location.origin}/#grant=grant-1/tok-abc`);
    expect(copied).toContain('do not share it');
    // Feedback: button label flips and a status line confirms the copy.
    expect(waBtn.textContent).toBe('Copied ✓');
    expect(card.querySelector('#grPendingStatus').textContent).toContain('WhatsApp message copied');
    // No network activity: the handoff is purely client-side.
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(postsBeforeCopy);
  });

  it('never renders the claim token into the page, even after the copy', async () => {
    await submitRequest();
    await new Promise((r) => setTimeout(r, 10));
    const card = document.getElementById('grantModalCard');
    expect(card.textContent).not.toContain('tok-abc');
    const waBtn = card.querySelector('#grWhatsAppBtn');
    stubClipboardCapture({});
    try {
      waBtn.click();
      await new Promise((r) => setTimeout(r, 25));
    } finally {
      restoreNavigator();
    }
    expect(card.textContent).not.toContain('tok-abc');
    expect(card.textContent).not.toContain('#grant=');
  });

  it('still copies an honest message without the link when no token is stored', async () => {
    // Submit normally, then strip the credential to simulate the rare case of
    // a token the browser cannot read back — the handoff must not embed a
    // broken link, and the rest of the message must survive.
    await submitRequest();
    await new Promise((r) => setTimeout(r, 10));
    localStorage.removeItem('gikomart_grantToken:grant-1');

    const card = document.getElementById('grantModalCard');
    const capture = {};
    stubClipboardCapture(capture);
    try {
      card.querySelector('#grWhatsAppBtn').click();
      await new Promise((r) => setTimeout(r, 25));
    } finally {
      restoreNavigator();
    }
    const copied = capture.text;
    expect(copied).toContain('Request: Quick Sale (24h) — listing package');
    expect(copied).toContain('My WhatsApp: 0712345678');
    expect(copied).not.toContain('#grant=');
  });
});

describe('Free Grant request — approval transition', () => {
  it('announces approval explicitly, then shows the redemption form', async () => {
    grantStatusResult = () => jsonResponse({ success: true, status: 'approved', type: 'listing' });
    const card = await submitRequest();
    await new Promise((r) => setTimeout(r, 10));

    expect(card.textContent).toContain('Your free grant was approved');
    expect(card.textContent).toContain('Your grant is approved and ready. Complete the form below to publish your listing');
    // The existing redemption UI is presented, not a different flow.
    expect(card.querySelector('#grantRedeemForm')).not.toBeNull();
    expect(card.querySelector('#g-title')).not.toBeNull();
    expect(card.querySelector('#grRedeemBtn')).not.toBeNull();
  });
});

describe('Free Grant request — rejection transition', () => {
  it('shows an explicit rejected state with no success messaging', async () => {
    grantStatusResult = () => jsonResponse({ success: true, status: 'rejected', type: 'listing' });
    const card = await submitRequest();
    await new Promise((r) => setTimeout(r, 10));

    expect(card.textContent).toContain('Grant request not approved');
    expect(card.textContent).toContain("wasn't approved at this time");
    expect(card.textContent).not.toContain('Request submitted ✓');
    expect(card.textContent).not.toContain('approved 🎉');
    // A rejected grant is terminal: the stored claim is cleared so it can never
    // be redeemed from this browser.
    expect(localStorage.getItem('gikomart_grantToken:grant-1')).toBeNull();
  });
});

describe('Free Grant request — failure', () => {
  it('restores the button, shows a readable error, and keeps what the seller typed', async () => {
    grantSubmitResult = () => ({ ok: false, status: 500, json: async () => ({ success: false }) });
    const card = await submitRequest();
    await new Promise((r) => setTimeout(r, 10));

    const btn = card.querySelector('#grSubmitBtn');
    expect(btn).not.toBeNull();
    expect(btn.disabled).toBe(false);
    expect(btn.textContent).toBe('Submit request');
    // Friendly message, no stack trace or internal detail.
    expect(card.querySelector('#grStatus').textContent).toContain('Something went wrong on our end');
    // The form survived so the seller can retry without retyping.
    expect(card.querySelector('#grantRequestForm')).not.toBeNull();
    expect(card.querySelector('#gr-whatsapp').value).toBe('0712345678');
    // Nothing was recorded as a pending grant.
    expect(localStorage.getItem('gikomart_grantToken:grant-1')).toBeNull();
  });
});

describe('Free Grant request — reload behaviour', () => {
  it('offers to resume the existing request instead of inviting a duplicate', async () => {
    await submitRequest();
    await new Promise((r) => setTimeout(r, 10));
    closeGrantModalIfOpen();

    // Simulates returning after a reload: fresh DOM state, same localStorage.
    const card = openGrantModal();
    expect(card.textContent).toContain('You already have a grant request on this device');
    expect(card.querySelector('#grResumeBtn')).not.toBeNull();

    // Resuming while still pending lands on the pending state, not the form.
    card.querySelector('#grResumeBtn').click();
    await new Promise((r) => setTimeout(r, 10));
    expect(card.textContent).toContain('Request submitted ✓');
    expect(card.querySelector('#grantRequestForm')).toBeNull();
  });

  it('shows no resume banner after a rejection — a rejected request is terminal', async () => {
    grantStatusResult = () => jsonResponse({ success: true, status: 'rejected', type: 'listing' });
    await submitRequest();
    await new Promise((r) => setTimeout(r, 10));
    closeGrantModalIfOpen();

    // The claim was already cleared when the rejection was shown, so a reload
    // finds nothing to resume and offers a fresh request instead.
    const card = openGrantModal();
    expect(card.textContent).not.toContain('You already have a grant request on this device');
    expect(card.querySelector('#grResumeBtn')).toBeNull();
    expect(card.querySelector('#grantRequestForm')).not.toBeNull();
    expect(localStorage.getItem('gikomart_grantToken:grant-1')).toBeNull();
  });
});

describe('Free Grant request — request-form label associations (a11y)', () => {
  // Each visible label must be programmatically associated with its control
  // via label[for] pointing at the control's real id inside the rendered card.
  const EXPECTED_PAIRS = [
    ['gr-type', 'What do you need?'],
    ['gr-package', 'Package'],
    ['gr-whatsapp', 'Your WhatsApp number'],
  ];

  it('associates the visible labels with gr-type, gr-package and gr-whatsapp when the form renders', () => {
    const card = openGrantModal();
    for (const [id, labelText] of EXPECTED_PAIRS) {
      const control = card.querySelector(`#${id}`);
      expect(control, `#${id} must exist in the rendered request form`).not.toBeNull();
      const label = card.querySelector(`label[for="${id}"]`);
      expect(label, `a label[for="${id}"] must exist in the rendered request form`).not.toBeNull();
      // The association must resolve: the label's for targets the control's actual id,
      // and the label is the one carrying the intended visible text.
      expect(label.getAttribute('for')).toBe(id);
      expect(control.id).toBe(id);
      expect(label.textContent.trim()).toBe(labelText);
    }
  });

  it('keeps the associations intact after the type change repopulates gr-package', async () => {
    const card = openGrantModal();
    const typeSel = card.querySelector('#gr-type');
    typeSel.value = 'store';
    typeSel.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 10));
    for (const [id] of EXPECTED_PAIRS) {
      const label = card.querySelector(`label[for="${id}"]`);
      expect(label, `after a type change, label[for="${id}"] must still exist and point at #${id}`).not.toBeNull();
      expect(label.getAttribute('for')).toBe(id);
      expect(card.querySelector(`#${id}`)).not.toBeNull();
    }
  });
});

// Last on purpose: it leaves a submit in flight, and its afterEach resolves it
// so the app's in-flight guard is cleared for any later test.
describe('Free Grant request — submitting state', () => {
  afterEach(async () => {
    if (grantSubmitRelease) {
      grantSubmitRelease(jsonResponse({ success: true, claimId: 'grant-1', claimToken: 'tok-abc', status: 'pending', type: 'listing' }, 201));
      grantSubmitRelease = null;
      await new Promise((r) => setTimeout(r, 10));
    }
  });

  it('disables the button, labels it as submitting, and blocks duplicate submission', async () => {
    grantSubmitDeferred = new Promise((resolve) => { grantSubmitRelease = resolve; });

    const card = openGrantModal();
    card.querySelector('#gr-whatsapp').value = '0712345678';
    const form = card.querySelector('#grantRequestForm');
    const btn = card.querySelector('#grSubmitBtn');

    // Two rapid submits (double click) — only one request may be created.
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 10));

    expect(btn.disabled).toBe(true);
    expect(btn.textContent).toBe('Submitting request…');
    const posts = calls.filter((c) => c.url.includes('/api/grants') && c.method === 'POST');
    expect(posts).toHaveLength(1);

    grantSubmitRelease(jsonResponse({ success: true, claimId: 'grant-1', claimToken: 'tok-abc', status: 'pending', type: 'listing' }, 201));
    grantSubmitRelease = null;
    await new Promise((r) => setTimeout(r, 10));

    // Success transitions to the persistent pending state.
    expect(card.querySelector('#grantRequestForm')).toBeNull();
    expect(card.textContent).toContain('Request submitted ✓');
  });
});
