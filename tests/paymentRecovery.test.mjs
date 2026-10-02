/* eslint-disable no-undef -- document/window/localStorage/Event come from the JSDOM instance built below */
// P3/P5 regression: exponential backoff for payment-status polling, and the
// Recovery state it hands off to once the automatic window is exhausted.
//
// The REAL app.js is driven against the REAL public/index.html with a stubbed
// fetch — no app.js refactor and no exported internals needed, because the
// whole flow is reachable through the real delegated submit listener (the same
// harness pattern as domTerms.test.mjs / xssEscaping.test.mjs).
//
// Fake timers collapse the 2+4+8+16+32 = 62s poll window to instant test time,
// so this never actually waits. Only setTimeout/clearTimeout are faked: Date
// and the rest stay real so jsdom internals keep working.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

const INVOICE_ID = 'INV-RECOVERY-1';
const OWNER_TOKEN = 'tok-recovery-abc';
const CREATED_LISTING_ID = 'lst-created-1';

const fetchCalls = [];
// What GET /api/payments/status/:invoiceId answers. Flipped to a completed
// payload just before the manual check, to prove Recovery → Success.
let statusPayload = { success: true, status: 'pending' };
const statusCallCount = () => fetchCalls.filter((c) => c.url.includes('/payments/status/')).length;

beforeAll(async () => {
  const { JSDOM, VirtualConsole } = await import('jsdom');
  const { readFileSync } = await import('node:fs');
  const path = await import('node:path');
  const html = readFileSync(path.join(process.cwd(), 'public', 'index.html'), 'utf8');
  const virtualConsole = new VirtualConsole();
  virtualConsole.forwardTo(console); // jsdom 29: forwardTo (was sendTo)
  const dom = new JSDOM(html, { url: 'https://gikomart.test/', virtualConsole });

  globalThis.document = dom.window.document;
  globalThis.window = dom.window;
  globalThis.Event = dom.window.Event;
  globalThis.localStorage = dom.window.localStorage;

  const jsonResponse = (body) => ({ ok: true, status: 200, json: async () => body });
  vi.stubGlobal('fetch', vi.fn(async (url) => {
    const u = String(url);
    fetchCalls.push({ url: u });
    if (u.includes('/terms/versions')) {
      return jsonResponse({ success: true, versions: { GIKOMART_TERMS_OF_SERVICE: '1.0.0', STORE_OWNER_TERMS: '1.0.0', SELLER_TERMS: '1.0.0', BUYER_TERMS: '1.0.0' } });
    }
    if (u.includes('/payments/initiate-listing')) {
      return jsonResponse({ success: true, message: 'STK push sent. Check your phone.', amount: 50, invoiceId: INVOICE_ID, ownerToken: OWNER_TOKEN });
    }
    if (u.includes('/payments/status/')) return jsonResponse(statusPayload);
    if (u.includes('/listings')) return jsonResponse({ success: true, count: 0, total: 0, page: 1, totalPages: 1, listings: [] });
    return { ok: false, status: 404, json: async () => ({ success: false }) };
  }));

  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

  await import('../public/assets/js/app.js');
  // document readyState is 'complete', so app.js's DOMContentLoaded listener
  // never fires on its own — dispatch it manually and let the async init chain
  // (loadTermsVersions → … → loadListings) settle. A single await drains the
  // whole microtask queue, so no real wall-clock wait is needed.
  document.dispatchEvent(new Event('DOMContentLoaded'));
  await vi.advanceTimersByTimeAsync(0);
});

afterAll(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// Fill the sell form and submit through the REAL listener
// (sellForm → handleSubmit), which posts /payments/initiate-listing and hands
// off to pollListingStatus(invoiceId).
function submitListingPayment() {
  document.getElementById('f-title').value = 'Backoff Regression Widget';
  document.getElementById('f-category').value = 'Electronics';
  document.getElementById('f-condition').value = 'Excellent';
  document.getElementById('f-price').value = '1500';
  document.getElementById('f-description').value = 'Exercises the payment status poll.';
  document.getElementById('f-seller').value = 'Tester';
  document.getElementById('f-whatsapp').value = '0712345678';
  document.getElementById('sellForm').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
}

describe('P3 — payment status polling backoff', () => {
  it('checks immediately, then waits 2s/4s/8s/16s/32s and stops after 5 attempts', async () => {
    submitListingPayment();
    await vi.advanceTimersByTimeAsync(0);

    // Attempt 0 fires with no delay: one status check is already in flight.
    expect(statusCallCount()).toBe(1);

    // Advance to just before each boundary and assert nothing fired, then cross
    // it and assert exactly one more check. Together these pin the exact gap
    // sequence [2000, 4000, 8000, 16000, 32000].
    const cross = async (advanceMs, expected) => {
      await vi.advanceTimersByTimeAsync(advanceMs);
      expect(statusCallCount()).toBe(expected);
    };

    await cross(1999, 1);   // ...2s gap not yet elapsed
    await cross(1, 2);      // +2s → attempt 1
    await cross(3999, 2);   // ...4s gap
    await cross(1, 3);      // +4s → attempt 2
    await cross(7999, 3);   // ...8s gap
    await cross(1, 4);      // +8s → attempt 3
    await cross(15999, 4);  // ...16s gap
    await cross(1, 5);      // +16s → attempt 4 (the last automatic check)
    await cross(31999, 5);  // +32s elapsed; the poll window is over — no 6th check
  });

  it('renders the Recovery state once the window expires, releasing the publish button', async () => {
    await vi.advanceTimersByTimeAsync(1); // the 32s delay expires → hand-off, not a 6th fetch
    expect(statusCallCount()).toBe(5);

    const statusEl = document.getElementById('formStatus');
    expect(statusEl.textContent).toContain('Payment is still processing');
    expect(statusEl.textContent).toContain(INVOICE_ID);

    const manualBtn = statusEl.querySelector('[data-manual-check]');
    expect(manualBtn).toBeTruthy();
    expect(manualBtn.textContent).toBe('Check Status Now');

    // A stalled payment must not leave the seller stuck with a disabled button.
    expect(document.getElementById('submitBtn').disabled).toBe(false);
  });

  it('a manual check runs exactly one status request and transitions to Success', async () => {
    statusPayload = { success: true, status: 'completed', listingId: CREATED_LISTING_ID };

    const manualBtn = document.querySelector('#formStatus [data-manual-check]');
    manualBtn.click();
    // The listener switches the button to its busy state before the async check.
    expect(manualBtn.disabled).toBe(true);
    expect(manualBtn.textContent).toBe('Checking…');

    await vi.advanceTimersByTimeAsync(0);

    expect(statusCallCount()).toBe(6); // 5 automatic + exactly 1 manual
    const statusEl = document.getElementById('formStatus');
    expect(statusEl.textContent).toBe('✅ Payment confirmed — your listing is live!');
    expect(statusEl.className).toContain('success');

    // The pending token (keyed by invoiceId) was re-keyed onto the listing id,
    // so edit/delete controls now appear for the freshly created listing.
    expect(localStorage.getItem(`gikomart_ownerToken:${CREATED_LISTING_ID}`)).toBe(OWNER_TOKEN);
    expect(localStorage.getItem(`gikomart_pendingToken:${INVOICE_ID}`)).toBeNull();
  });
});

describe('P3 — negative paths', () => {
  it('a manual check on a still-pending payment updates the message but stays in Recovery', async () => {
    statusPayload = { success: true, status: 'pending' };
    const base = statusCallCount();

    submitListingPayment();
    await vi.advanceTimersByTimeAsync(0);
    expect(statusCallCount()).toBe(base + 1);

    // Exhaust the automatic window (2+4+8+16+32 = 62s) to hand off to Recovery.
    await vi.advanceTimersByTimeAsync(62000);
    expect(statusCallCount()).toBe(base + 5);

    const statusEl = document.getElementById('formStatus');
    const manualBtn = statusEl.querySelector('[data-manual-check]');
    expect(manualBtn).toBeTruthy();

    // The provider still reports pending: the manual check must not fabricate a
    // success or a failure — it only re-renders the still-processing message.
    manualBtn.click();
    await vi.advanceTimersByTimeAsync(0);

    expect(statusCallCount()).toBe(base + 6); // 5 automatic + exactly 1 manual
    expect(statusEl.textContent).toBe(`Still processing. Please contact support with reference: ${INVOICE_ID}.`);
    expect(statusEl.className).toContain('error');
    expect(statusEl.textContent).not.toContain('confirmed');
    expect(statusEl.textContent).not.toContain('failed');
  });

  it('polling detects a failed payment and shows the Failure UI, not a network error', async () => {
    statusPayload = { success: true, status: 'failed' };
    const base = statusCallCount();

    submitListingPayment();
    await vi.advanceTimersByTimeAsync(0);

    // One poll is enough: 'failed' is a terminal provider state.
    expect(statusCallCount()).toBe(base + 1);

    const statusEl = document.getElementById('formStatus');
    expect(statusEl.textContent).toBe('❌ Payment failed — nothing was listed. Try again.');
    expect(statusEl.className).toContain('error');
    // Distinct from a transport failure, whose copy starts with "Couldn't connect".
    expect(statusEl.textContent).not.toContain("Couldn't connect");

    // The pending token is dropped so a failed payment can never adopt a listing.
    expect(localStorage.getItem(`gikomart_pendingToken:${INVOICE_ID}`)).toBeNull();

    // Terminal: no retry is scheduled, so time passing causes no further poll.
    await vi.advanceTimersByTimeAsync(60000);
    expect(statusCallCount()).toBe(base + 1);
  });
});

describe('P3 — poll lifecycle across navigation', () => {
  it('keeps polling after the user switches views (no stranded disabled publish button)', async () => {
    statusPayload = { success: true, status: 'pending' };
    const base = statusCallCount();

    // Stand on the Sell view, then start a payment that schedules a retry.
    document.querySelector('.nav-link[data-view="sell"]').click();
    expect(document.getElementById('view-sell').classList.contains('active')).toBe(true);

    submitListingPayment();
    await vi.advanceTimersByTimeAsync(0);
    expect(statusCallCount()).toBe(base + 1);

    // Navigate away mid-poll: the Sell view is hidden...
    document.querySelector('.nav-link[data-view="browse"]').click();
    expect(document.getElementById('view-sell').classList.contains('active')).toBe(false);

    // ...yet the scheduled retry still fires — the poll is not view-scoped, which
    // is what prevents a permanently disabled publish button.
    await vi.advanceTimersByTimeAsync(2000);
    expect(statusCallCount()).toBe(base + 2);

    // Drain the rest of the window so no timer leaks into the next test.
    await vi.advanceTimersByTimeAsync(60000);
  });

  it('aborts the pending poll on pagehide (tab close / navigation teardown)', async () => {
    statusPayload = { success: true, status: 'pending' };
    const base = statusCallCount();

    submitListingPayment();
    await vi.advanceTimersByTimeAsync(0);
    expect(statusCallCount()).toBe(base + 1);

    window.dispatchEvent(new Event('pagehide'));

    await vi.advanceTimersByTimeAsync(60000);
    // The retry was cancelled outright — not merely delayed.
    expect(statusCallCount()).toBe(base + 1);
  });
});
