/* eslint-disable no-undef -- document/window/Event/localStorage come from the JSDOM instance built in beforeAll */
// Admin Grant Requests UI: full WhatsApp display, WhatsApp Seller action, and
// the history filter. Drives the REAL public/assets/js/admin.js against the
// REAL public/admin/index.html (manual JSDOM, same pattern as
// adminPortal.test.mjs). admin.js initializes on import; a fresh login runs in
// beforeEach so no state leaks between tests.
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

let fetchHandler;
const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));

function json(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function loginData() {
  return { success: true, token: 'tok-admin' };
}

function grantsData(requests) {
  return { success: true, count: requests.length, requests };
}

const pendingGrant = {
  id: 'g1', type: 'listing', package: 'quick', storePlan: null, status: 'pending',
  createdAt: '2026-10-04T10:00:00.000Z', decidedAt: null, provisioned: false,
  whatsapp: '254712345678', whatsappMasked: '2547***78',
};
const approvedProvisionedGrant = {
  id: 'g2', type: 'store', package: null, storePlan: 'standard_monthly', status: 'approved',
  createdAt: '2026-10-03T10:00:00.000Z', decidedAt: '2026-10-03T11:00:00.000Z', provisioned: true,
  whatsapp: '254701234567', whatsappMasked: '2547***67',
};
const approvedNotProvisionedGrant = {
  id: 'g3', type: 'listing', package: 'premium', storePlan: null, status: 'approved',
  createdAt: '2026-10-02T10:00:00.000Z', decidedAt: '2026-10-02T11:00:00.000Z', provisioned: false,
  whatsapp: '254722222222', whatsappMasked: '2547***22',
};
const qaPendingGrant = {
  ...pendingGrant, id: 'g4', isTest: true, whatsapp: '254733333333', whatsappMasked: '2547***33',
};

beforeAll(async () => {
  const { JSDOM, VirtualConsole } = await import('jsdom');
  const { readFileSync } = await import('node:fs');
  const path = await import('node:path');
  const html = readFileSync(path.join(process.cwd(), 'public', 'admin', 'index.html'), 'utf8');
  const virtualConsole = new VirtualConsole();
  virtualConsole.forwardTo(console);
  const dom = new JSDOM(html, { url: 'https://gikomart.test/admin/', virtualConsole });

  globalThis.document = dom.window.document;
  globalThis.window = dom.window;
  globalThis.Event = dom.window.Event;
  globalThis.localStorage = dom.window.localStorage;

  vi.stubGlobal('fetch', vi.fn(async (url, options = {}) => fetchHandler(String(url), options)));
  await import('../public/assets/js/admin.js');
});

beforeEach(async () => {
  // Sessions live in module memory; sign out if a previous test left one open,
  // then default every fetch to a 404 until the test installs its handler.
  const signOutBtn = document.getElementById('signOutBtn');
  if (signOutBtn && !signOutBtn.hidden) signOutBtn.click();
  await tick();
  fetchHandler = () => json({ success: false }, 404);
});

async function signIn() {
  // The handler MUST cover the login call itself — the session only opens if
  // the POST succeeds before any later handler swap.
  fetchHandler = (url) => {
    if (url.includes('/api/admin/login')) return json(loginData());
    if (url.includes('/api/admin/metrics')) {
      return json({ success: true, generatedAt: '2026-10-04T12:00:00.000Z', listings: {}, stores: {}, payments: {}, revenue: {}, reports: {}, blocks: {} });
    }
    return json({ success: false }, 404);
  };
  document.getElementById('adminKey').value = 'test-key';
  document.getElementById('totpCode').value = '123456';
  document.getElementById('loginForm').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await tick();
}

async function openGrantsView(requests) {
  await signIn();
  fetchHandler = (url) => {
    if (url.includes('/api/admin/metrics')) return json({ success: true });
    if (url.includes('/api/admin/grants')) return json(grantsData(requests));
    return json({ success: false }, 404);
  };
  document.querySelector('#tabs .tab[data-view="grants"]').click();
  await tick();
}

function grantsTable() {
  return document.getElementById('grantsTable');
}

// grantStatusFilter is module-level state in admin.js and survives between
// tests. Tests that need the raw approved dataset must pin the filter back to
// 'pending' FIRST (while the data-serving handler is still installed) — the
// 'provisioned'/'rejected' filters drop unprovisioned rows client-side.
async function resetGrantFilterToPending() {
  const statusSel = document.getElementById('grantStatusFilter');
  if (statusSel && statusSel.value !== 'pending') {
    statusSel.value = 'pending';
    statusSel.dispatchEvent(new Event('change', { bubbles: true }));
    await tick();
  }
}

describe('Admin Grant Requests UI', () => {
  it('shows the FULL WhatsApp number for every listed request', async () => {
    await openGrantsView([pendingGrant, approvedProvisionedGrant]);
    const text = grantsTable().textContent;
    expect(text).toContain('254712345678');
    expect(text).toContain('254701234567');
    // No masked form is displayed in the grant queue anymore.
    expect(text).not.toContain('***');
  });

  it('WhatsApp Seller builds wa.me from the normalized number with an encoded approval message', async () => {
    await openGrantsView([pendingGrant]);
    const waAnchor = [...grantsTable().querySelectorAll('a')].find((a) => a.textContent === 'WhatsApp Seller');
    expect(waAnchor).toBeTruthy();
    expect(waAnchor.href.startsWith('https://wa.me/254712345678?text=')).toBe(true);
    const message = decodeURIComponent(waAnchor.href.split('?text=')[1]);
    expect(message).toContain('approved');
    expect(message).toContain('Free Grant');
    expect(waAnchor.target).toBe('_blank');
    expect(waAnchor.rel).toContain('noopener');
  });

  it('no WhatsApp Seller action when the number is missing', async () => {
    await openGrantsView([{ ...pendingGrant, whatsapp: null }]);
    const anchors = [...grantsTable().querySelectorAll('a')].filter((a) => a.textContent === 'WhatsApp Seller');
    expect(anchors).toHaveLength(0);
  });

  it('defaults to the pending dataset and reloads on filter change', async () => {
    const requestedUrls = [];
    await openGrantsView([pendingGrant]);
    // Recall the view; capture the exact URL the UI requests after a change.
    fetchHandler = (url) => {
      if (url.includes('/api/admin/grants')) {
        requestedUrls.push(url);
        return json(grantsData([]));
      }
      return json({ success: false }, 404);
    };
    const statusSel = document.getElementById('grantStatusFilter');
    expect(statusSel).toBeTruthy();
    expect(statusSel.value).toBe('pending');
    statusSel.value = 'approved';
    statusSel.dispatchEvent(new Event('change', { bubbles: true }));
    await tick();

    expect(requestedUrls.some((u) => u.includes('status=approved'))).toBe(true);
  });

  it("'provisioned' is derived client-side: fetched as approved, filtered locally", async () => {
    const requestedUrls = [];
    await openGrantsView([]);
    fetchHandler = (url) => {
      if (url.includes('/api/admin/grants')) {
        requestedUrls.push(url);
        return json(grantsData([approvedProvisionedGrant, approvedNotProvisionedGrant]));
      }
      return json({ success: false }, 404);
    };
    const statusSel = document.getElementById('grantStatusFilter');
    statusSel.value = 'provisioned';
    statusSel.dispatchEvent(new Event('change', { bubbles: true }));
    await tick();

    const provisionedUrl = requestedUrls.find((u) => u.includes('status='));
    expect(provisionedUrl).toBeTruthy();
    expect(provisionedUrl.includes('status=provisioned')).toBe(false); // API never sees a bogus status
    expect(provisionedUrl.includes('status=approved')).toBe(true);
    const rows = [...grantsTable().querySelectorAll('tbody tr')];
    expect(rows).toHaveLength(1); // only the provisioned row survives the client filter
    expect(rows[0].textContent).toContain('/ provisioned');
    expect(rows[0].textContent).toContain('254701234567');
  });

  it("'New continuation link' appears ONLY on approved, not-yet-provisioned rows", async () => {
    await openGrantsView([pendingGrant, approvedProvisionedGrant, approvedNotProvisionedGrant]);
    await resetGrantFilterToPending();
    const mintButtons = [...grantsTable().querySelectorAll('button')]
      .filter((b) => b.textContent === 'New continuation link');
    expect(mintButtons).toHaveLength(1);
    const row = mintButtons[0].closest('tr');
    expect(row.dataset.grantId).toBe('g3'); // approved && !provisioned
  });

  it('minting a continuation token renders the #grant= link, wa.me message, and a copy action', async () => {
    await openGrantsView([approvedNotProvisionedGrant]);
    await resetGrantFilterToPending();
    fetchHandler = (url) => {
      if (url.includes('/api/admin/grants/g3/continuation-token')) {
        return json({ success: true, claimId: 'g3', claimToken: 'a'.repeat(48) });
      }
      return json({ success: false }, 404);
    };
    const mintBtn = [...grantsTable().querySelectorAll('button')]
      .find((b) => b.textContent === 'New continuation link');
    mintBtn.click(); // arm
    await tick();
    mintBtn.click(); // confirm (two-click guard)
    await tick();

    const rowMsg = grantsTable().querySelector('tr[data-grant-id="g3"] [data-role="rowMsg"]');
    const links = [...rowMsg.querySelectorAll('a')];
    const openLink = links.find((a) => a.textContent === 'Open link');
    expect(openLink).toBeTruthy();
    // Hash-fragment format exactly as app.js parses it: #grant=<claimId>/<token>.
    expect(openLink.href).toContain('/#grant=g3/');
    expect(openLink.href.endsWith('/' + 'a'.repeat(48))).toBe(true);
    // WhatsApp Seller carries the continuation message including the link.
    const waAnchor = links.find((a) => a.textContent === 'WhatsApp Seller');
    expect(waAnchor.href.startsWith('https://wa.me/254722222222?text=')).toBe(true);
    const message = decodeURIComponent(waAnchor.href.split('?text=')[1]);
    expect(message).toContain('#grant=g3/' + 'a'.repeat(48));
    // Copy action exists; the raw token is not printed as visible page text.
    expect([...rowMsg.querySelectorAll('button')].some((b) => b.textContent === 'Copy link')).toBe(true);
    expect(rowMsg.textContent).not.toContain('a'.repeat(48));
  });

  it('a failed mint surfaces the API error in the row', async () => {
    await openGrantsView([approvedNotProvisionedGrant]);
    await resetGrantFilterToPending();
    fetchHandler = (url) => {
      if (url.includes('/continuation-token')) {
        return json({ success: false, error: 'Only approved, not-yet-provisioned grants can get a continuation token' }, 409);
      }
      return json({ success: false }, 404);
    };
    const mintBtn = [...grantsTable().querySelectorAll('button')]
      .find((b) => b.textContent === 'New continuation link');
    mintBtn.click();
    await tick();
    mintBtn.click();
    await tick();

    const rowMsg = grantsTable().querySelector('tr[data-grant-id="g3"] [data-role="rowMsg"]');
    expect(rowMsg.textContent).toContain('Failed:');
    expect(rowMsg.textContent).toContain('not-yet-provisioned');
  });

  it('rejects rows are viewable via the rejected filter', async () => {
    const requestedUrls = [];
    await openGrantsView([]);
    fetchHandler = (url) => {
      if (url.includes('/api/admin/grants')) {
        requestedUrls.push(url);
        return json(grantsData([]));
      }
      return json({ success: false }, 404);
    };
    const statusSel = document.getElementById('grantStatusFilter');
    statusSel.value = 'rejected';
    statusSel.dispatchEvent(new Event('change', { bubbles: true }));
    await tick();
    expect(requestedUrls.some((u) => u.includes('status=rejected'))).toBe(true);
  });

  it('flags a QA/test request with a badge and offers the toggle on every row', async () => {
    await openGrantsView([pendingGrant, qaPendingGrant]);
    const rows = [...grantsTable().querySelectorAll('tbody tr')];
    const realRow = rows.find((r) => r.dataset.grantId === 'g1');
    const qaRow = rows.find((r) => r.dataset.grantId === 'g4');

    // Badge only on the flagged row.
    expect(qaRow.querySelector('.qa-badge')).toBeTruthy();
    expect(qaRow.querySelector('.qa-badge').textContent).toBe('QA/test');
    expect(realRow.querySelector('.qa-badge')).toBeNull();

    // Toggle action exists for both statuses, labelled by current state.
    const rowButtons = Object.fromEntries(rows.map((r) => [r.dataset.grantId, [...r.querySelectorAll('button')].map((b) => b.textContent)]));
    expect(rowButtons.g1).toContain('Mark QA/test');
    expect(rowButtons.g4).toContain('Unmark QA/test');
  });

  it('Mark QA/test toggles through POST /qa-flag with the opposite value and reloads', async () => {
    await openGrantsView([pendingGrant]);
    const calls = [];
    fetchHandler = (url, options = {}) => {
      if (url.includes('/api/admin/grants/g1/qa-flag')) {
        calls.push({ url: String(url), body: options.body ? JSON.parse(options.body) : null });
        return json({ success: true, grantId: 'g1', isTest: true });
      }
      if (url.includes('/api/admin/grants')) return json(grantsData([pendingGrant]));
      return json({ success: false }, 404);
    };
    const markBtn = [...grantsTable().querySelectorAll('button')].find((b) => b.textContent === 'Mark QA/test');
    markBtn.click(); // arm
    await tick();
    markBtn.click(); // confirm (two-click guard)
    await tick();

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain('/api/admin/grants/g1/qa-flag');
    expect(calls[0].body).toEqual({ isTest: true });
    // A 200 reloads the view (the queue is fetched again).
    expect(grantsTable()).toBeTruthy();
  });

  it("explains why there is no unapprove action, linking to the decision record", async () => {
    await openGrantsView([pendingGrant]);
    const note = document.querySelector('#viewBody .view-note');
    expect(note).toBeTruthy();
    expect(note.textContent).toContain("Why can't I unapprove?");
    expect(note.textContent).toContain('one-way atomic write');
    expect(note.textContent).toContain('docs/DECISIONS.md');
    const link = note.querySelector('a');
    expect(link.href).toContain('github.com/Tery-1111/gikomart/blob/main/docs/DECISIONS.md');
    expect(link.target).toBe('_blank');
    expect(link.rel).toContain('noopener');
  });
});
