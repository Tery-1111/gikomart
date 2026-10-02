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
