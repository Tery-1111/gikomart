/* eslint-disable no-undef -- document/window/localStorage/sessionStorage/Event come from the JSDOM instance built below */
// Drives the REAL public/assets/js/admin.js against the REAL
// public/admin/index.html with a stubbed fetch, using a manual JSDOM instance on
// the default node environment (same pattern as tests/domTerms.test.mjs). admin.js
// initializes immediately on execution, so no DOMContentLoaded dispatch is needed.
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

const fetchCalls = [];
let fetchHandler;

function json(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

const LOGIN_URL = '/api/admin/login';
const METRICS_URL = '/api/admin/metrics';
const HEALTH_URL = '/api/admin/health';

function metricsData() {
  return {
    generatedAt: '2026-10-02T12:00:00.000Z',
    listings: { active: 11, flagged: 2 },
    stores: { active: 3, flagged: 1, suspended: 1 },
    payments: { pending: 4, completed24h: 5, failed24h: 6 },
    revenue: { currency: 'KSh', last24h: 0, last7d: 500, last30d: 1250, byType30d: { listing: 700, boost: 300, store: 250 } },
    reports: { open: 7 },
    blocks: { total: 8 },
  };
}

function healthData() {
  return {
    success: true,
    status: 'healthy',
    checks: { mongodb: true, cloudinary: true },
    timestamp: '2026-10-02T12:00:00.000Z',
    uptimeSec: 123,
  };
}

function defaultHandler(url) {
  if (url.includes(LOGIN_URL)) return json({ success: true, token: 'tok-abc' });
  if (url.includes(METRICS_URL)) return json(metricsData());
  if (url.includes(HEALTH_URL)) return json(healthData());
  return json({ success: false }, 404);
}

const EXPECTED_METRICS = [
  ['listings.active', 'Active listings', '11'],
  ['listings.flagged', 'Flagged listings', '2'],
  ['stores.active', 'Active stores', '3'],
  ['stores.flagged', 'Flagged stores', '1'],
  ['stores.suspended', 'Suspended stores', '1'],
  ['payments.pending', 'Pending payments', '4'],
  ['payments.completed24h', 'Completed payments (24h)', '5'],
  ['payments.failed24h', 'Failed payments (24h)', '6'],
  ['revenue.last24h', 'Revenue (24h)', 'KSh 0'],
  ['revenue.last7d', 'Revenue (7 days)', 'KSh 500'],
  ['revenue.last30d', 'Revenue (30 days)', 'KSh 1,250'],
  ['revenue.listing30d', 'Listing revenue (30 days)', 'KSh 700'],
  ['revenue.boost30d', 'Boost revenue (30 days)', 'KSh 300'],
  ['revenue.store30d', 'Store revenue (30 days)', 'KSh 250'],
  ['reports.open', 'Open reports', '7'],
  ['blocks.total', 'Blocked contacts', '8'],
];

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
  dom.window.addEventListener('error', (e) => console.log('WINDOW-ERROR:', e.error && e.error.stack ? e.error.stack : e.message));

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

async function signIn(key = 'test-key', code = '123456') {
  submitLogin(key, code);
  await tick();
}

beforeEach(() => {
  const signOutBtn = document.getElementById('signOutBtn');
  if (!signOutBtn.hidden) signOutBtn.click();
  fetchCalls.length = 0;
  fetchHandler = defaultHandler;
});

describe('Initial state', () => {
  it('shows the login form and hides the app and sign-out button', () => {
    expect(document.getElementById('loginSection').hidden).toBe(false);
    expect(document.getElementById('appSection').hidden).toBe(true);
    expect(document.getElementById('signOutBtn').hidden).toBe(true);
  });
});

describe('Client-side validation', () => {
  it('requires the key and a 6-digit code and never calls fetch', () => {
    submitLogin('', '123456');
    expect(document.getElementById('loginMsg').textContent).toBe('Enter the admin key.');
    expect(fetchCalls).toHaveLength(0);

    submitLogin('key', '12');
    expect(document.getElementById('loginMsg').textContent).toBe('Enter the 6-digit code.');
    expect(fetchCalls).toHaveLength(0);

    submitLogin('key', '12345a');
    expect(document.getElementById('loginMsg').textContent).toBe('Enter the 6-digit code.');
    expect(fetchCalls).toHaveLength(0);
  });
});

describe('Sign in', () => {
  it('posts the key and code, stores the token in memory, then loads the dashboard', async () => {
    await signIn();

    const login = fetchCalls.find((c) => c.url.includes(LOGIN_URL));
    expect(login).toBeTruthy();
    expect(login.options.method).toBe('POST');
    expect(login.options.headers['X-Admin-Key']).toBe('test-key');
    expect(JSON.parse(login.options.body)).toEqual({ code: '123456' });

    expect(document.getElementById('appSection').hidden).toBe(false);
    expect(document.getElementById('loginSection').hidden).toBe(true);
    expect(document.getElementById('adminKey').value).toBe('');
    expect(document.getElementById('totpCode').value).toBe('');
    expect(fetchCalls.some((c) => c.url.includes(METRICS_URL))).toBe(true);
  });

  it('sends X-Admin-Session and never X-Admin-Key on non-login requests', async () => {
    await signIn();
    const nonLogin = fetchCalls.filter((c) => !c.url.includes(LOGIN_URL));
    expect(nonLogin.length).toBeGreaterThan(0);
    for (const call of nonLogin) {
      expect(call.options.headers['X-Admin-Session']).toBe('tok-abc');
      expect(call.options.headers['X-Admin-Key']).toBeUndefined();
    }
  });

  it('writes nothing to browser storage', async () => {
    await signIn();
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });
});

describe('Sign-in errors', () => {
  async function failedLogin(resp, opts = {}) {
    fetchHandler = () => (opts.reject ? Promise.reject(new Error('x')) : json(resp, opts.status || 200));
    submitLogin('test-key', '123456');
    await tick();
  }

  it('maps 429 with a numeric retryAfterSec', async () => {
    await failedLogin({ error: 'Too many attempts', retryAfterSec: 90 }, { status: 429 });
    expect(document.getElementById('loginMsg').textContent).toContain('90');
    expect(document.getElementById('totpCode').value).toBe('');
  });

  it('maps 401', async () => {
    await failedLogin({ error: 'x' }, { status: 401 });
    expect(document.getElementById('loginMsg').textContent).toBe('Invalid or already used code.');
    expect(document.getElementById('totpCode').value).toBe('');
  });

  it('maps 403', async () => {
    await failedLogin({ error: 'x' }, { status: 403 });
    expect(document.getElementById('loginMsg').textContent).toBe('Invalid admin key.');
    expect(document.getElementById('totpCode').value).toBe('');
  });

  it('maps 400', async () => {
    await failedLogin({ error: 'x' }, { status: 400 });
    expect(document.getElementById('loginMsg').textContent).toBe('Check the code and that 2FA is set up.');
    expect(document.getElementById('totpCode').value).toBe('');
  });

  it('maps a network failure', async () => {
    await failedLogin(null, { reject: true });
    expect(document.getElementById('loginMsg').textContent).toBe('Could not connect.');
    expect(document.getElementById('totpCode').value).toBe('');
  });
});

describe('Session expiry', () => {
  it('returns to login on a 401 and allows a fresh sign-in', async () => {
    await signIn();
    expect(document.getElementById('appSection').hidden).toBe(false);

    fetchHandler = (url) => (url.includes(METRICS_URL) ? json({ success: false }, 401) : defaultHandler(url));
    document.getElementById('dashReload').click();
    await tick();

    expect(document.getElementById('loginSection').hidden).toBe(false);
    expect(document.getElementById('loginMsg').textContent).toBe('Session expired. Sign in again.');

    fetchHandler = (url) => (url.includes(LOGIN_URL) ? json({ success: true, token: 'tok-2' }) : defaultHandler(url));
    await signIn();

    expect(document.getElementById('appSection').hidden).toBe(false);
    const lastMetrics = [...fetchCalls].reverse().find((c) => c.url.includes(METRICS_URL));
    expect(lastMetrics.options.headers['X-Admin-Session']).toBe('tok-2');
  });
});

describe('Sign out', () => {
  it('hides the app, shows login and empties the view body', async () => {
    await signIn();
    expect(document.getElementById('viewBody').childNodes.length).toBeGreaterThan(0);

    document.getElementById('signOutBtn').click();

    expect(document.getElementById('appSection').hidden).toBe(true);
    expect(document.getElementById('loginSection').hidden).toBe(false);
    expect(document.getElementById('viewBody').childNodes).toHaveLength(0);
  });
});

describe('Dashboard', () => {
  it('renders all sixteen metrics in order with exact labels and values', async () => {
    await signIn();
    const cards = [...document.querySelectorAll('#metrics [data-metric]')];
    expect(cards.map((c) => c.dataset.metric)).toEqual(EXPECTED_METRICS.map((m) => m[0]));

    for (const [key, label, value] of EXPECTED_METRICS) {
      const card = document.querySelector(`#metrics [data-metric="${key}"]`);
      expect(card, key).not.toBeNull();
      expect(card.querySelector('dt').textContent).toBe(label);
      expect(card.querySelector('dd').textContent).toBe(value);
    }
  });
});

describe('Health tab', () => {
  it('fetches admin health and renders the five entries', async () => {
    await signIn();
    fetchCalls.length = 0;

    document.querySelector('.tab[data-view="health"]').click();
    await tick();

    expect(fetchCalls.some((c) => c.url.includes(HEALTH_URL))).toBe(true);
    const items = [...document.querySelectorAll('#healthList [data-health]')];
    expect(items.map((i) => i.dataset.health)).toEqual(['status', 'mongodb', 'cloudinary', 'timestamp', 'uptimeSec']);
  });
});

describe('View failures', () => {
  it('shows an error and a Retry button on a 500, and retries on click', async () => {
    await signIn();
    let metricsStatus = 500;
    fetchHandler = (url) => (url.includes(METRICS_URL) ? json({ success: false }, metricsStatus) : defaultHandler(url));

    document.getElementById('dashReload').click();
    await tick();

    expect(document.getElementById('viewMsg').textContent).toBe('Could not load this view.');
    const retry = document.getElementById('retryBtn');
    expect(retry).not.toBeNull();

    const before = fetchCalls.filter((c) => c.url.includes(METRICS_URL)).length;
    metricsStatus = 200;
    retry.click();
    await tick();

    const after = fetchCalls.filter((c) => c.url.includes(METRICS_URL)).length;
    expect(after).toBeGreaterThan(before);
    expect(document.getElementById('retryBtn')).toBeNull();
  });

  it('shows the rate-limit message on a 429', async () => {
    await signIn();
    fetchHandler = (url) => (url.includes(METRICS_URL) ? json({ success: false }, 429) : defaultHandler(url));

    document.getElementById('dashReload').click();
    await tick();

    expect(document.getElementById('viewMsg').textContent).toBe('Too many requests. Wait a minute and try again.');
    expect(document.getElementById('retryBtn')).not.toBeNull();
  });
});

// ── Step 4: reports and payments tabs ──────────────────────────────────────

function reportsData(reports) {
  return { success: true, count: reports.length, reports: reports };
}

function paymentsData(payments) {
  return { success: true, count: payments.length, payments: payments };
}

const REPORT_OPEN_LISTING = {
  id: 'rep-1', targetType: 'listing', targetId: 'lst-1', reason: 'scam', details: 'fake details',
  status: 'open', moderationAction: null, resolvedAt: null, resolvedBy: null, note: '',
  createdAt: '2026-10-01T09:30:00.000Z',
};
const REPORT_OPEN_STORE = {
  id: 'rep-2', targetType: 'store', targetId: 'sto-1', reason: 'prohibited_item', details: '',
  status: 'open', moderationAction: null, resolvedAt: null, resolvedBy: null, note: '',
  createdAt: '2026-10-01T10:00:00.000Z',
};
const REPORT_RESOLVED = {
  id: 'rep-3', targetType: 'listing', targetId: 'lst-9', reason: 'other', details: 'x',
  status: 'actioned', moderationAction: 'removed', resolvedAt: '2026-10-01T11:00:00.000Z',
  resolvedBy: 'owner', note: 'done', createdAt: '2026-10-01T08:00:00.000Z',
};
const PAYMENT_PENDING = {
  _id: 'pay-1', type: 'listing', status: 'pending', amount: 150, package: 'premium',
  invoiceId: 'INV-1', phoneNumber: '0700000000', createdAt: '2026-10-01T09:00:00.000Z',
};
const PAYMENT_COMPLETED = {
  _id: 'pay-2', type: 'store', status: 'completed', amount: 200, storePlan: 'standard_monthly',
  invoiceId: 'INV-2', phoneNumber: 'redacted', createdAt: '2026-10-01T09:05:00.000Z',
};
const PAYMENT_NO_INVOICE = {
  _id: 'pay-3', type: 'boost', status: 'pending', amount: 80, boostType: 'rush',
  invoiceId: '', phoneNumber: '0700000000', createdAt: '2026-10-01T09:10:00.000Z',
};

async function openReportTab(handler) {
  await signIn();
  if (handler) fetchHandler = handler;
  document.querySelector('.tab[data-view="reports"]').click();
  await tick();
}

async function openPaymentsTab(handler) {
  await signIn();
  if (handler) fetchHandler = handler;
  document.querySelector('.tab[data-view="payments"]').click();
  await tick();
}

describe('Reports tab', () => {
  it('queries status=open by default and adds targetType only when chosen', async () => {
    const urls = [];
    await openReportTab((url) => {
      if (url.includes('/api/admin/reports')) { urls.push(url); return json(reportsData([REPORT_OPEN_LISTING])); }
      return defaultHandler(url);
    });

    expect(urls[0]).toContain('/api/admin/reports?status=open');
    expect(urls[0]).not.toContain('targetType');

    const statusSel = document.getElementById('reportStatus');
    statusSel.value = 'all';
    statusSel.dispatchEvent(new Event('change', { bubbles: true }));
    await tick();

    const typeSel = document.getElementById('reportType');
    typeSel.value = 'store';
    typeSel.dispatchEvent(new Event('change', { bubbles: true }));
    await tick();

    const filtered = urls[urls.length - 1];
    expect(filtered).toContain('status=all');
    expect(filtered).toContain('targetType=store');

    const freshType = document.getElementById('reportType');
    freshType.value = '';
    freshType.dispatchEvent(new Event('change', { bubbles: true }));
    await tick();
    expect(urls[urls.length - 1]).not.toContain('targetType');
  });

  it('renders one row per report with exact cells and scoped action controls', async () => {
    await openReportTab((url) => (url.includes('/api/admin/reports')
      ? json(reportsData([REPORT_OPEN_LISTING, REPORT_OPEN_STORE, REPORT_RESOLVED]))
      : defaultHandler(url)));

    expect(document.querySelectorAll('#reportsTable tbody tr')).toHaveLength(3);

    const listingCells = [...document.querySelector('tr[data-report-id="rep-1"]').querySelectorAll('td')];
    expect(listingCells[0].textContent).toBe('2026-10-01 09:30 UTC');
    expect(listingCells[1].textContent).toBe('listing');
    expect(listingCells[2].textContent).toBe('lst-1');
    expect(listingCells[3].textContent).toBe('scam');
    expect(listingCells[4].textContent).toBe('fake details');
    expect(listingCells[5].textContent).toBe('open');

    const listingRow = document.querySelector('tr[data-report-id="rep-1"]');
    expect(listingRow.querySelectorAll('[data-action="moderate"]')).toHaveLength(3);

    const storeRow = document.querySelector('tr[data-report-id="rep-2"]');
    expect([...storeRow.querySelectorAll('[data-action="moderate"]')].some((b) => b.textContent === 'Suspend store')).toBe(true);

    const resolvedRow = document.querySelector('tr[data-report-id="rep-3"]');
    expect([...resolvedRow.querySelectorAll('td')][5].textContent).toBe('actioned / removed / done');
    expect(resolvedRow.querySelector('[data-action="moderate"]')).toBeNull();
    expect(resolvedRow.querySelector('[data-action="resolve"]')).toBeNull();
  });

  it('treats hostile details and target ids as literal text', async () => {
    const evil = { ...REPORT_OPEN_LISTING, id: 'rep-evil', targetId: '<b>x</b>', details: '<img src=x onerror=alert(1)>' };
    await openReportTab((url) => (url.includes('/api/admin/reports') ? json(reportsData([evil])) : defaultHandler(url)));

    expect(document.querySelector('#viewBody img')).toBeNull();
    expect(document.querySelector('#viewBody b')).toBeNull();
    expect(document.getElementById('viewBody').textContent).toContain('<img src=x onerror=alert(1)>');
    expect(document.getElementById('viewBody').textContent).toContain('<b>x</b>');
  });

  it('confirms moderation with two clicks and sends the listing request', async () => {
    const calls = [];
    await openReportTab((url, options = {}) => {
      if (url.includes('/api/admin/reports')) return json(reportsData([REPORT_OPEN_LISTING]));
      if (url.includes('/moderate') || url.includes('/suspend')) { calls.push({ url, options }); return json({ success: true }); }
      return defaultHandler(url);
    });

    const approve = document.querySelector('tr[data-report-id="rep-1"] [data-action="moderate"][data-value="approved"]');
    const remove = document.querySelector('tr[data-report-id="rep-1"] [data-action="moderate"][data-value="removed"]');

    approve.click();
    expect(approve.textContent).toBe('Confirm?');
    expect(calls).toHaveLength(0);

    remove.click();
    expect(remove.textContent).toBe('Confirm?');
    expect(calls).toHaveLength(0);

    remove.click();
    await tick();

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('/api/listings/lst-1/moderate');
    expect(calls[0].options.method).toBe('PUT');
    expect(calls[0].options.headers['X-Admin-Session']).toBe('tok-abc');
    expect(JSON.parse(calls[0].options.body)).toEqual({ action: 'removed' });

    const row = document.querySelector('tr[data-report-id="rep-1"]');
    expect(row.querySelector('[data-role="rowMsg"]').textContent).toBe('Applied: removed');
    expect(row.querySelector('[data-field="resolution"]').value).toBe('actioned');
    expect(row.querySelector('[data-field="moderationAction"]').value).toBe('removed');
  });

  it('sends the store moderation request for a flagged store', async () => {
    const calls = [];
    await openReportTab((url, options = {}) => {
      if (url.includes('/api/admin/reports')) return json(reportsData([REPORT_OPEN_STORE]));
      if (url.includes('/moderate')) { calls.push({ url, options }); return json({ success: true }); }
      return defaultHandler(url);
    });

    const flag = document.querySelector('tr[data-report-id="rep-2"] [data-action="moderate"][data-value="flagged"]');
    flag.click();
    flag.click();
    await tick();

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('/api/admin/stores/sto-1/moderate');
    expect(JSON.parse(calls[0].options.body)).toEqual({ action: 'flagged' });
  });

  it('suspends a store with a bodyless request', async () => {
    const calls = [];
    await openReportTab((url, options = {}) => {
      if (url.includes('/api/admin/reports')) return json(reportsData([REPORT_OPEN_STORE]));
      if (url.includes('/suspend')) { calls.push({ url, options }); return json({ success: true }); }
      return defaultHandler(url);
    });

    const suspend = document.querySelector('tr[data-report-id="rep-2"] [data-action="moderate"][data-value="suspended"]');
    suspend.click();
    suspend.click();
    await tick();

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('/api/admin/stores/sto-1/suspend');
    expect(calls[0].options.method).toBe('PUT');
    expect(calls[0].options.body).toBeUndefined();
  });

  it('reverts an armed button after four seconds without a second click', async () => {
    vi.useFakeTimers();
    try {
      const calls = [];
      fetchHandler = (url) => {
        if (url.includes('/api/admin/reports')) return json(reportsData([REPORT_OPEN_LISTING]));
        if (url.includes('/moderate')) { calls.push(url); return json({ success: true }); }
        return defaultHandler(url);
      };
      document.getElementById('adminKey').value = 'test-key';
      document.getElementById('totpCode').value = '123456';
      document.getElementById('loginForm').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await vi.advanceTimersByTimeAsync(60);
      document.querySelector('.tab[data-view="reports"]').click();
      await vi.advanceTimersByTimeAsync(60);

      const approve = document.querySelector('tr[data-report-id="rep-1"] [data-action="moderate"][data-value="approved"]');
      approve.click();
      expect(approve.textContent).toBe('Confirm?');

      await vi.advanceTimersByTimeAsync(4100);
      expect(approve.textContent).toBe('Approve');
      expect(approve.dataset.armed).toBeUndefined();
      expect(calls).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('sends the documented resolve body and reloads', async () => {
    const puts = [];
    let listCalls = 0;
    await openReportTab((url, options = {}) => {
      if (url.includes('/resolve')) { puts.push({ url, options }); return json({ success: true }); }
      if (url.includes('/api/admin/reports')) { listCalls += 1; return json(reportsData([REPORT_OPEN_LISTING])); }
      return defaultHandler(url);
    });

    const row = document.querySelector('tr[data-report-id="rep-1"]');
    row.querySelector('[data-field="resolution"]').value = 'actioned';
    row.querySelector('[data-field="moderationAction"]').value = 'removed';
    row.querySelector('[data-field="note"]').value = ' done ';
    row.querySelector('[data-action="resolve"]').click();
    await tick();

    expect(puts).toHaveLength(1);
    expect(puts[0].url).toBe('/api/admin/reports/rep-1/resolve');
    expect(puts[0].options.method).toBe('PUT');
    expect(JSON.parse(puts[0].options.body)).toEqual({ resolution: 'actioned', note: 'done', moderationAction: 'removed' });
    expect(listCalls).toBeGreaterThanOrEqual(2);
  });

  it('omits moderationAction for a dismissed resolution', async () => {
    const puts = [];
    await openReportTab((url, options = {}) => {
      if (url.includes('/resolve')) { puts.push({ url, options }); return json({ success: true }); }
      if (url.includes('/api/admin/reports')) return json(reportsData([REPORT_OPEN_LISTING]));
      return defaultHandler(url);
    });

    const row = document.querySelector('tr[data-report-id="rep-1"]');
    row.querySelector('[data-field="resolution"]').value = 'dismissed';
    row.querySelector('[data-action="resolve"]').click();
    await tick();

    const body = JSON.parse(puts[0].options.body);
    expect(body).toEqual({ resolution: 'dismissed', note: '' });
    expect(Object.prototype.hasOwnProperty.call(body, 'moderationAction')).toBe(false);
  });

  it('shows a 409 resolve error in the row', async () => {
    await openReportTab((url) => {
      if (url.includes('/resolve')) return json({ success: false, error: 'Report already resolved' }, 409);
      if (url.includes('/api/admin/reports')) return json(reportsData([REPORT_OPEN_LISTING]));
      return defaultHandler(url);
    });

    const row = document.querySelector('tr[data-report-id="rep-1"]');
    row.querySelector('[data-action="resolve"]').click();
    await tick();

    expect(row.querySelector('[data-role="rowMsg"]').textContent).toBe('Failed: Report already resolved');
  });

  it('shows the rate-limit message with Retry on a 429', async () => {
    await signIn();
    fetchHandler = (url) => (url.includes('/api/admin/reports') ? json({ success: false }, 429) : defaultHandler(url));
    document.querySelector('.tab[data-view="reports"]').click();
    await tick();

    expect(document.getElementById('viewMsg').textContent).toBe('Too many requests. Wait a minute and try again.');
    expect(document.getElementById('retryBtn')).not.toBeNull();
  });
});

describe('Payments tab', () => {
  it('queries without params by default and adds filters when chosen', async () => {
    const urls = [];
    await openPaymentsTab((url) => {
      if (url.includes('/api/admin/payments')) { urls.push(url); return json(paymentsData([PAYMENT_PENDING])); }
      return defaultHandler(url);
    });

    expect(urls[0]).toBe('/api/admin/payments');

    const statusSel = document.getElementById('paymentStatus');
    statusSel.value = 'failed';
    statusSel.dispatchEvent(new Event('change', { bubbles: true }));
    await tick();

    const typeSel = document.getElementById('paymentType');
    typeSel.value = 'boost';
    typeSel.dispatchEvent(new Event('change', { bubbles: true }));
    await tick();

    const last = urls[urls.length - 1];
    expect(last).toContain('status=failed');
    expect(last).toContain('type=boost');
  });

  it('renders masked phones, amounts and replay availability', async () => {
    await openPaymentsTab((url) => (url.includes('/api/admin/payments')
      ? json(paymentsData([PAYMENT_PENDING, PAYMENT_COMPLETED, PAYMENT_NO_INVOICE]))
      : defaultHandler(url)));

    const pendingCells = [...document.querySelector('tr[data-payment-id="pay-1"]').querySelectorAll('td')];
    expect(pendingCells[3].textContent).toBe('KSh 150');
    expect(pendingCells[4].textContent).toBe('premium');
    expect(pendingCells[5].textContent).toBe('INV-1');
    expect(pendingCells[6].textContent).toBe('0700***00');
    expect(document.querySelector('tr[data-payment-id="pay-1"] [data-action="replay"]')).not.toBeNull();

    const completedCells = [...document.querySelector('tr[data-payment-id="pay-2"]').querySelectorAll('td')];
    expect(completedCells[6].textContent).toBe('redacted');
    expect(document.querySelector('tr[data-payment-id="pay-2"] [data-action="replay"]')).toBeNull();

    expect(document.querySelector('tr[data-payment-id="pay-3"] [data-action="replay"]')).toBeNull();
  });

  it('confirms a replay with two clicks and reloads on success', async () => {
    const calls = [];
    let listCalls = 0;
    await openPaymentsTab((url, options = {}) => {
      if (url.includes('/replay')) { calls.push({ url, options }); return json({ success: true }); }
      if (url.includes('/api/admin/payments')) { listCalls += 1; return json(paymentsData([PAYMENT_PENDING])); }
      return defaultHandler(url);
    });

    const btn = document.querySelector('tr[data-payment-id="pay-1"] [data-action="replay"]');
    btn.click();
    expect(btn.textContent).toBe('Confirm?');
    expect(calls).toHaveLength(0);

    btn.click();
    await tick();

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('/api/admin/payments/INV-1/replay');
    expect(calls[0].options.method).toBe('POST');
    expect(calls[0].options.body).toBeUndefined();
    expect(listCalls).toBeGreaterThanOrEqual(2);
  });
});

// ── Step 5: blocks and audit log tabs ──────────────────────────────────────

function blocksData(blocks) {
  return { success: true, count: blocks.length, blocks: blocks };
}

function auditData(logs) {
  return { success: true, count: logs.length, logs: logs };
}

const BLOCK_PHONE = {
  id: 'blk-1', sourceType: 'phone', sourceId: null, reason: 'scam', createdBy: 'owner',
  createdAt: '2026-10-01T09:00:00.000Z',
};
const BLOCK_LISTING = {
  id: 'blk-2', sourceType: 'listing', sourceId: 'lst-1', reason: 'prohibited_item', createdBy: 'owner',
  createdAt: '2026-10-01T09:05:00.000Z',
};
const AUDIT_1 = {
  actor: 'owner', action: 'listing.moderate', resource: 'listing', resourceId: 'lst-1',
  result: 'success', metadata: { action: 'approved' }, timestamp: '2026-10-01T09:00:00.000Z',
};

async function openBlocksTab(handler) {
  await signIn();
  if (handler) fetchHandler = handler;
  document.querySelector('.tab[data-view="blocks"]').click();
  await tick();
}

async function openAuditTab(handler) {
  await signIn();
  if (handler) fetchHandler = handler;
  document.querySelector('.tab[data-view="audit"]').click();
  await tick();
}

describe('Tabs', () => {
  it('shows all six tabs in the documented order', () => {
    const labels = [...document.querySelectorAll('#tabs .tab')].map((t) => t.textContent);
    expect(labels).toEqual(['Dashboard', 'Reports', 'Payments', 'Blocks', 'Audit log', 'Health']);
  });

  it('keeps admin.js free of the forbidden constructs', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const content = fs.readFileSync(path.join(process.cwd(), 'public', 'assets', 'js', 'admin.js'), 'utf8');
    for (const word of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'eval', 'new Function', 'localStorage', 'sessionStorage']) {
      expect(content.includes(word), `admin.js must not contain "${word}"`).toBe(false);
    }
  });
});

describe('Blocks tab', () => {
  it('lists blocks and posts a phone block without leaking the number', async () => {
    const posts = [];
    let listCalls = 0;
    await openBlocksTab((url, options = {}) => {
      if (url.includes('/api/admin/blocks') && options.method === 'POST') { posts.push({ url, options }); return json({ success: true, created: 1, alreadyBlocked: 0 }, 201); }
      if (url.includes('/api/admin/blocks')) { listCalls += 1; return json(blocksData([BLOCK_PHONE, BLOCK_LISTING])); }
      return defaultHandler(url);
    });

    const cells = [...document.querySelector('tr[data-block-id="blk-1"]').querySelectorAll('td')];
    expect(cells[0].textContent).toBe('2026-10-01 09:00 UTC');
    expect(cells[1].textContent).toBe('phone');
    expect(cells[2].textContent).toBe('—');
    expect(cells[3].textContent).toBe('scam');
    expect(cells[4].textContent).toBe('owner');
    expect(document.querySelector('tr[data-block-id="blk-2"] td:nth-child(3)').textContent).toBe('lst-1');

    const before = listCalls;
    document.getElementById('blockTarget').value = '0700000000';
    document.getElementById('blockReason').value = 'scam';
    document.getElementById('blockForm').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await tick();

    expect(posts).toHaveLength(1);
    expect(posts[0].options.headers['X-Admin-Session']).toBe('tok-abc');
    expect(JSON.parse(posts[0].options.body)).toEqual({ sourceType: 'phone', reason: 'scam', phone: '0700000000' });
    expect(document.getElementById('blockMsg').textContent).toBe('Added: 1 new, 0 already blocked.');
    expect(document.getElementById('blockTarget').value).toBe('');
    expect(document.getElementById('blockReason').value).toBe('');
    expect(listCalls).toBeGreaterThan(before);
    expect(document.getElementById('viewBody').textContent).not.toContain('0700000000');
  });

  it('switches to sourceId when the type is a listing', async () => {
    const posts = [];
    await openBlocksTab((url, options = {}) => {
      if (url.includes('/api/admin/blocks') && options.method === 'POST') { posts.push({ url, options }); return json({ success: true, created: 1, alreadyBlocked: 0 }, 201); }
      if (url.includes('/api/admin/blocks')) return json(blocksData([]));
      return defaultHandler(url);
    });

    const typeSel = document.getElementById('blockType');
    typeSel.value = 'listing';
    typeSel.dispatchEvent(new Event('change', { bubbles: true }));
    expect(document.getElementById('blockTarget').placeholder).toBe('Listing ID');
    expect(document.getElementById('blockTarget').type).toBe('text');

    document.getElementById('blockTarget').value = 'lst-1';
    document.getElementById('blockReason').value = 'r';
    document.getElementById('blockForm').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await tick();

    expect(JSON.parse(posts[0].options.body)).toEqual({ sourceType: 'listing', reason: 'r', sourceId: 'lst-1' });
  });

  it('requires a target and a reason and never fetches on those failures', async () => {
    const posts = [];
    await openBlocksTab((url, options = {}) => {
      if (url.includes('/api/admin/blocks') && options.method === 'POST') { posts.push(url); return json({ success: true }, 201); }
      if (url.includes('/api/admin/blocks')) return json(blocksData([]));
      return defaultHandler(url);
    });

    document.getElementById('blockTarget').value = '';
    document.getElementById('blockReason').value = 'r';
    document.getElementById('blockForm').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    expect(document.getElementById('blockMsg').textContent).toBe('Enter a target.');
    expect(posts).toHaveLength(0);

    document.getElementById('blockTarget').value = '0700000000';
    document.getElementById('blockReason').value = '';
    document.getElementById('blockForm').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    expect(document.getElementById('blockMsg').textContent).toBe('Enter a reason.');
    expect(posts).toHaveLength(0);
  });

  it('shows the server error on a failed block', async () => {
    await openBlocksTab((url, options = {}) => {
      if (url.includes('/api/admin/blocks') && options.method === 'POST') return json({ success: false, error: 'Listing not found' }, 404);
      if (url.includes('/api/admin/blocks')) return json(blocksData([]));
      return defaultHandler(url);
    });

    const typeSel = document.getElementById('blockType');
    typeSel.value = 'listing';
    typeSel.dispatchEvent(new Event('change', { bubbles: true }));
    document.getElementById('blockTarget').value = 'lst-missing';
    document.getElementById('blockReason').value = 'r';
    document.getElementById('blockForm').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await tick();

    expect(document.getElementById('blockMsg').textContent).toBe('Failed: Listing not found');
  });

  it('confirms block removal with two clicks and reloads', async () => {
    const deletes = [];
    let listCalls = 0;
    await openBlocksTab((url, options = {}) => {
      if (url.includes('/api/admin/blocks') && options.method === 'DELETE') { deletes.push(url); return json({ success: true }); }
      if (url.includes('/api/admin/blocks')) { listCalls += 1; return json(blocksData([BLOCK_PHONE])); }
      return defaultHandler(url);
    });

    const btn = document.querySelector('tr[data-block-id="blk-1"] [data-action="unblock"]');
    btn.click();
    expect(btn.textContent).toBe('Confirm?');
    expect(deletes).toHaveLength(0);

    const before = listCalls;
    btn.click();
    await tick();

    expect(deletes).toHaveLength(1);
    expect(deletes[0]).toBe('/api/admin/blocks/blk-1');
    expect(listCalls).toBeGreaterThan(before);
  });

  it('renders a hostile block reason as literal text', async () => {
    const evil = { ...BLOCK_PHONE, id: 'blk-evil', reason: '<script>alert(1)</script>' };
    await openBlocksTab((url) => (url.includes('/api/admin/blocks') ? json(blocksData([evil])) : defaultHandler(url)));

    expect(document.querySelector('#viewBody script')).toBeNull();
    expect(document.getElementById('viewBody').textContent).toContain('<script>alert(1)</script>');
  });
});

describe('Audit log tab', () => {
  it('queries limit=50 by default and adds action/resource filters', async () => {
    const urls = [];
    await openAuditTab((url) => {
      if (url.includes('/api/admin/audit-logs')) { urls.push(url); return json(auditData([AUDIT_1])); }
      return defaultHandler(url);
    });

    expect(urls[0]).toBe('/api/admin/audit-logs?limit=50');

    document.getElementById('auditAction').value = 'listing.moderate';
    document.getElementById('auditResource').value = 'listing';
    document.getElementById('auditLoad').click();
    await tick();

    const last = urls[urls.length - 1];
    expect(last).toContain('limit=50');
    expect(last).toContain('action=listing.moderate');
    expect(last).toContain('resource=listing');
  });

  it('renders rows and truncates long metadata to 200 characters', async () => {
    const log = { ...AUDIT_1, metadata: { note: 'x'.repeat(260) } };
    await openAuditTab((url) => (url.includes('/api/admin/audit-logs') ? json(auditData([log])) : defaultHandler(url)));

    const cells = [...document.querySelector('tr[data-audit="1"]').querySelectorAll('td')];
    expect(cells[0].textContent).toBe('2026-10-01 09:00 UTC');
    expect(cells[1].textContent).toBe('owner');
    expect(cells[2].textContent).toBe('listing.moderate');
    expect(cells[3].textContent).toBe('listing');
    expect(cells[4].textContent).toBe('lst-1');
    expect(cells[5].textContent).toBe('success');
    expect(cells[6].textContent).toHaveLength(201);
    expect(cells[6].textContent.endsWith('…')).toBe(true);
  });

  it('shows Load older only when exactly 50 logs are returned', async () => {
    const makeLogs = (n) => Array.from({ length: n }, (_, i) => ({ ...AUDIT_1, resourceId: 'r-' + i }));

    await openAuditTab((url) => (url.includes('/api/admin/audit-logs') ? json(auditData(makeLogs(49))) : defaultHandler(url)));
    expect(document.getElementById('auditMore')).toBeNull();

    fetchHandler = (url) => (url.includes('/api/admin/audit-logs') ? json(auditData(makeLogs(50))) : defaultHandler(url));
    document.querySelector('.tab[data-view="audit"]').click();
    await tick();
    expect(document.getElementById('auditMore')).not.toBeNull();
  });

  it('Load older requests before=last timestamp and appends rows', async () => {
    const page1 = Array.from({ length: 50 }, (_, i) => ({ ...AUDIT_1, resourceId: 'p1-' + i, timestamp: '2026-10-01T09:00:00.000Z' }));
    page1[49] = { ...page1[49], timestamp: '2026-09-30T12:00:00.000Z' };
    const page2 = Array.from({ length: 50 }, (_, i) => ({ ...AUDIT_1, resourceId: 'p2-' + i, timestamp: '2026-09-30T11:00:00.000Z' }));
    const urls = [];
    await openAuditTab((url) => {
      if (url.includes('/api/admin/audit-logs')) {
        urls.push(url);
        return url.includes('before=') ? json(auditData(page2)) : json(auditData(page1));
      }
      return defaultHandler(url);
    });

    document.getElementById('auditMore').click();
    await tick();

    const lastUrl = urls[urls.length - 1];
    const before = new URL(lastUrl, 'https://gikomart.test').searchParams.get('before');
    expect(before).toBe('2026-09-30T12:00:00.000Z');
    expect(document.querySelectorAll('#auditTable tbody tr')).toHaveLength(100);
  });

  it('renders a hostile actor as literal text', async () => {
    const log = { ...AUDIT_1, actor: '<i>x</i>' };
    await openAuditTab((url) => (url.includes('/api/admin/audit-logs') ? json(auditData([log])) : defaultHandler(url)));

    expect(document.querySelector('#viewBody i')).toBeNull();
    expect(document.getElementById('viewBody').textContent).toContain('<i>x</i>');
  });
});
