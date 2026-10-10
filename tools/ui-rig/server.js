// GikoMart UI verification rig — mock API on plain express.
//
// Serves the repo's public/ folder and a mock /api whose response shapes are
// copied from the real controllers (never invented). Scenario behaviour and
// injected latency are controlled from the control page at /__rig/.
//
// The rig never imports src/ and never touches a database.

const express = require('express');
const path = require('path');
const fixtures = require('./fixtures');

const app = express();
app.use(express.json());

const state = {
  scenario: 'normal',
  latencyMs: 0,
};

const SCENARIOS = ['normal', 'empty', 'slow', 'offline', 'server-error', 'busy', 'no-contact', 'pay-success', 'pay-pending', 'pay-failed', 'pay-cancelled'];

// ─── Latency + scenario gate for /api ───────────────────────────────────────
app.use('/api', (req, res, next) => {
  // slow adds a fixed extra delay on top of the configured latencyMs.
  const delay = state.latencyMs + (state.scenario === 'slow' ? 2500 : 0);
  const proceed = () => {
    if (state.scenario === 'offline') {
      // Destroy the socket so fetch rejects as a network failure.
      req.socket.destroy();
      return;
    }
    next();
  };
  if (delay > 0) setTimeout(proceed, delay);
  else proceed();
});

// Scenario shortcuts that short-circuit every /api route.
app.use('/api', (req, res, next) => {
  if (state.scenario === 'server-error') {
    // Shape copied from src/middleware/errorHandler.js (non-production builds
    // add a stack; the stable 500 body the frontend maps is the error string).
    return res.status(500).json({ error: 'Internal Server Error' });
  }
  if (state.scenario === 'busy') {
    return res.status(503).json({ success: false, error: 'Server is busy. Please wait a moment and try again.' });
  }
  next();
});

// ─── /__rig — control services (registered BEFORE /api) ─────────────────────
// Generated SVG placeholders: flat neutral fill with the aspect label.
const IMG_FILL = '#EAE4DA';
const IMG_TEXT = '#6B6660';
const IMG_SIZES = {
  'square.svg': [400, 400],
  'landscape.svg': [400, 300],
  'portrait.svg': [300, 400],
  'wide.svg': [640, 360],
  'tall.svg': [360, 640],
};

app.get('/__rig/img/:name', (req, res) => {
  const size = IMG_SIZES[req.params.name] || [200, 200];
  const [w, h] = size;
  const label = req.params.name.replace('.svg', '');
  res.type('image/svg+xml').send(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
    `<rect width="100%" height="100%" fill="${IMG_FILL}"/>` +
    `<text x="50%" y="50%" fill="${IMG_TEXT}" font-family="sans-serif" font-size="24" text-anchor="middle" dominant-baseline="middle">${label} ${w}x${h}</text>` +
    `</svg>`
  );
});

app.get('/__rig/state', (req, res) => {
  res.json({ scenario: state.scenario, latencyMs: state.latencyMs });
});

app.post('/__rig/state', (req, res) => {
  const { scenario, latencyMs } = req.body || {};
  if (scenario !== undefined) {
    if (!SCENARIOS.includes(scenario)) {
      return res.status(400).json({ success: false, error: `Unknown scenario: ${scenario}` });
    }
    state.scenario = scenario;
  }
  if (latencyMs !== undefined) {
    const n = Number(latencyMs);
    if (!Number.isInteger(n) || n < 0) {
      return res.status(400).json({ success: false, error: 'latencyMs must be a non-negative integer' });
    }
    state.latencyMs = n;
  }
  res.json({ scenario: state.scenario, latencyMs: state.latencyMs });
});

// ─── Mock API surfaces ──────────────────────────────────────────────────────
// Supporting endpoints (same shapes as the real controllers):
app.get('/api/support-contact', (req, res) => {
  // Shape from src/routes/supportContact.js — phone-only public subset.
  res.json({
    success: true,
    support: { phoneLocal: '0776844298', phoneInternational: '254776844298' },
  });
});

app.get('/api/listings/categories', (req, res) => {
  // Shape from src/controllers/listingController.js:26.
  res.json({ success: true, categories: fixtures.CATEGORIES });
});

app.get('/api/terms/versions', (req, res) => {
  res.json({
    success: true,
    versions: {
      GIKOMART_TERMS_OF_SERVICE: '1.0.0',
      STORE_OWNER_TERMS: '1.0.0',
      SELLER_TERMS: '1.0.0',
      BUYER_TERMS: '1.0.0',
    },
  });
});

// Browse / dashboard / store-scoped listings. Honours category, search
// (case-insensitive substring on title), page, limit and store_id; pagination
// fields copied from listingController.getListings (:97).
app.get('/api/listings', (req, res) => {
  const { category, search, page, limit, store_id } = req.query;
  let items = fixtures.LISTINGS;

  if (store_id) items = items.filter((l) => l.store_id === store_id);
  if (category) items = items.filter((l) => l.category === category);
  if (search) items = items.filter((l) => l.title.toLowerCase().includes(String(search).toLowerCase()));

  if (state.scenario === 'empty') items = [];

  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 50));
  const total = items.length;
  const totalPages = Math.ceil(total / limitNum) || 0;
  const paged = items.slice((pageNum - 1) * limitNum, pageNum * limitNum);
  // Response shape copied from listingController.getListings: sellerWhatsapp
  // omitted, store info flattened into store_name/store_slug.
  const sanitized = paged.map(({ sellerWhatsapp, store_id: sid, ...rest }) => ({
    ...rest,
    store_name: sid ? 'Rig One Campus Mart' : null,
    store_slug: sid ? 'rig-store-one' : null,
  }));
  res.json({ success: true, count: sanitized.length, total, page: pageNum, totalPages, listings: sanitized });
});

// Buyer contact gate. no-contact reproduces DECISIONS 37's dead end.
app.post('/api/terms/contact-acceptance', (req, res) => {
  // Shape from src/controllers/termsController.js:123-127.
  if (state.scenario === 'no-contact') {
    return res.json({ success: true, acceptanceId: 'rig-acceptance-1' });
  }
  res.json({ success: true, acceptanceId: 'rig-acceptance-1', sellerWhatsapp: '0700000001' });
});

// Public reports (open + toast only in the UI).
app.post('/api/reports', (req, res) => {
  res.json({ success: true });
});

// Listing payments. initiate always succeeds; the status poller drives the
// payment scenarios. invoiceId is handed out deterministically per payment.
let paymentSeq = 0;
const pendingPayments = new Map();

app.post('/api/payments/initiate-listing', (req, res) => {
  // Shape from paymentController.initiateListing (:337).
  const invoiceId = `rig-inv-${++paymentSeq}`;
  if (['pay-success', 'pay-pending', 'pay-failed', 'pay-cancelled'].includes(state.scenario)) {
    pendingPayments.set(invoiceId, { polls: 0, type: 'listing' });
  }
  res.json({ success: true, message: 'STK push sent. Check your phone.', invoiceId, amount: 50, ownerToken: 'rig-token' });
});

app.post('/api/payments/initiate-store-plan', (req, res) => {
  // Route contract from src/controllers/paymentController.js:345
  // (initiateStorePlan): the route itself is store-plan-specific, so the
  // payment TYPE is the route, not a request-body field — the frontend sends
  // { phoneNumber, storePlan, storeData, acceptance } and no explicit type.
  const invoiceId = `rig-inv-${++paymentSeq}`;
  if (['pay-success', 'pay-pending', 'pay-failed', 'pay-cancelled'].includes(state.scenario)) {
    pendingPayments.set(invoiceId, { polls: 0, type: 'store' });
  }
  res.json({ success: true, message: 'STK push sent. Check your phone.', invoiceId, amount: 150, ownerToken: 'rig-token' });
});

app.post('/api/payments/boost', (req, res) => {
  res.json({ success: true, message: 'STK push sent. Check your phone.', invoiceId: `rig-inv-${++paymentSeq}`, amount: 50 });
});

app.get('/api/payments/status/:invoiceId', (req, res) => {
  // Shape from paymentController.checkPaymentStatus (:921-930). The frontend
  // adoption gate (app.js:2457) keys on `data.storeId` alone — pollStoreStatus
  // saves the Store owner token against THAT storeId, closes the modal, and
  // renders the dashboard — so the completed response for a STORE-plan payment
  // must carry the store's id (the real controller returns
  // `storeId: payment.storeId || null`, stamped by the webhook at :806).
  const pending = pendingPayments.get(req.params.invoiceId);
  const isStore = pending && pending.type === 'store';
  const base = { success: true, type: isStore ? 'store' : 'listing', storeId: null, failedCode: null };

  if (state.scenario === 'pay-pending') {
    return res.json({ ...base, status: 'pending', listingId: null });
  }
  if (state.scenario === 'pay-failed') {
    return res.json({ ...base, status: 'failed', listingId: null, failedCode: null });
  }
  if (state.scenario === 'pay-cancelled') {
    return res.json({ ...base, status: 'failed', listingId: null, failedCode: '1032' });
  }
  if (state.scenario === 'pay-success' && pending) {
    pending.polls += 1;
    if (pending.polls === 1) {
      // First poll: realistic STK-pending state — still storeId-less·.
      return res.json({ ...base, status: 'pending', listingId: null });
    }
    if (isStore) {
      // Completed STORE-plan payment: the webhook created the store and
      // stamped its id on the payment; the listing id stays null (which is
      // what differentiates a completed store payment from a completed
      // listing payment in the real controller's response).
      const store = fixtures.STORES[0];
      const storeId = store && store._id ? store._id : 'rig-s-store';
      return res.json({ ...base, status: 'completed', listingId: null, storeId });
    }
    // Completed LISTING payment (unchanged behavior).
    return res.json({ ...base, status: 'completed', listingId: 'rig-l-01', storeId: null });
  }
  // normal: a standalone status probe without a tracked payment is just pending.
  res.json({ ...base, status: 'pending', listingId: null });
});

app.put('/api/listings/:id', (req, res) => {
  const listing = fixtures.LISTINGS.find((l) => l._id === req.params.id);
  if (!listing) return res.status(404).json({ success: false, error: 'Listing not found' });
  Object.assign(listing, req.body || {});
  // Shape from listingController.updateListing (:249).
  res.json({ success: true, listing });
});

app.delete('/api/listings/:id', (req, res) => {
  // Shape from listingController.deleteListing (:290).
  res.json({ success: true, message: 'Listing deleted' });
});

// Store routes.
const storeToken = (req) => req.get('X-Store-Owner-Token');

app.get('/api/stores/slug/:slug', (req, res) => {
  // Shape from storeController.getStoreBySlug (:83) via storeView.
  const store = fixtures.STORES.find((s) => s.slug === req.params.slug);
  if (!store) return res.status(404).json({ success: false, error: 'Store not found' });
  const listingCount = fixtures.LISTINGS.filter((l) => l.store_id === store._id).length;
  res.json({ success: true, store: fixtures.publicStoreView(store), listingCount });
});

app.get('/api/stores/:id', (req, res) => {
  // Owner view: contact PII included when the store token matches (:109).
  const store = fixtures.STORES.find((s) => s._id === req.params.id);
  if (!store) return res.status(404).json({ success: false, error: 'Store not found' });
  if (storeToken(req) !== 'rig-token') return res.status(403).json({ success: false, error: 'Not authorized' });
  const listingCount = fixtures.LISTINGS.filter((l) => l.store_id === store._id).length;
  res.json({ success: true, store: fixtures.ownerStoreView(store, listingCount), listingCount });
});

app.put('/api/stores/:id', (req, res) => {
  const store = fixtures.STORES.find((s) => s._id === req.params.id);
  if (!store) return res.status(404).json({ success: false, error: 'Store not found' });
  if (storeToken(req) !== 'rig-token') return res.status(403).json({ success: false, error: 'Not authorized' });
  Object.assign(store, req.body || {});
  res.json({ success: true, store });
});

app.delete('/api/stores/:id', (req, res) => {
  const idx = fixtures.STORES.findIndex((s) => s._id === req.params.id);
  if (idx === -1) return res.status(404).json({ success: false, error: 'Store not found' });
  if (storeToken(req) !== 'rig-token') return res.status(403).json({ success: false, error: 'Not authorized' });
  fixtures.STORES.splice(idx, 1);
  res.json({ success: true, message: 'Store and all associated listings deleted' });
});

app.post('/api/stores/:id/listings', (req, res) => {
  // Shape from storeController.createStoreListing (:612).
  const store = fixtures.STORES.find((s) => s._id === req.params.id);
  if (!store) return res.status(404).json({ success: false, error: 'Store not found' });
  if (storeToken(req) !== 'rig-token') return res.status(403).json({ success: false, error: 'Not authorized' });
  const listing = fixtures.LISTINGS[0];
  res.status(201).json({
    success: true,
    message: 'Listing published in your store — covered by your plan',
    listing,
  });
});

app.put('/api/stores/:id/attach-listing', (req, res) => {
  // Shape from storeController.attachListing (:377).
  res.json({ success: true, message: 'Listing attached to store' });
});

// ─── Free grant routes (claim-id decided, not scenario-decided) ─────────────
app.post('/api/grants', (req, res) => {
  // Shape from grantController.submitGrant (:163-170).
  res.status(201).json({
    success: true,
    message: 'Request submitted. The GikoMart admin will review it and contact you on WhatsApp.',
    claimId: 'rig-claim-pending',
    claimToken: 'rig-token',
    status: 'pending',
    type: (req.body && req.body.type) || 'listing',
  });
});

app.get('/api/grants/status/:claimId', (req, res) => {
  // Shape from grantController.getGrantStatus (:193-199).
  const claim = fixtures.GRANT_CLAIMS[req.params.claimId];
  if (!claim) return res.status(404).json({ success: false, error: 'Grant request not found' });
  res.json({ success: true, status: claim.status, type: claim.type, provisioned: false, resourceId: null });
});

app.post('/api/grants/:claimId/redeem', (req, res) => {
  // Shape from grantController.redeemGrant (:359-363).
  const claim = fixtures.GRANT_CLAIMS[req.params.claimId];
  if (!claim) return res.status(404).json({ success: false, error: 'Grant request not found' });
  if (claim.status !== 'approved') return res.status(409).json({ success: false, error: 'This grant request has not been approved yet' });
  res.status(201).json({ success: true, resource: { type: 'listing', id: 'rig-l-01' }, ownerToken: 'rig-token' });
});

// Uploads are not simulated by the rig (real Cloudinary); the UI treats 503 as
// a retryable busy signal, which is the honest failure for a mock.
app.post('/api/upload', (req, res) => {
  res.status(503).json({ success: false, error: 'Server busy — please try again in a moment' });
});

// ─── Fallback: anything un-simulated 404s loudly ─────────────────────────────
app.use('/api', (req, res) => {
  console.log(`[rig] not simulated: ${req.method} ${req.originalUrl}`);
  res.status(404).json({ success: false, error: 'Not simulated by the rig' });
});

// ─── Static app ─────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, '..', '..', 'public')));

// ─── Control page (plain string, no styling) ────────────────────────────────
app.get('/__rig/', (req, res) => {
  res.type('html').send(controlPage());
});

function controlPage() {
  const options = SCENARIOS.map((s) => `<option value="${s}">${s}</option>`).join('');
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>GikoMart UI rig control</title></head>
<body>
<h1>GikoMart UI rig control</h1>
<p>Scenario + latency are server state; seed buttons write localStorage of THIS origin (the rig origin). Open the app at <a href="/index.html">/index.html</a>.</p>
<p>
  <label>Scenario <select id="scenario">${options}</select></label>
  <label>Latency (ms) <input id="latency" type="number" value="${state.latencyMs}" min="0"></label>
  <button id="apply">Apply</button>
</p>
<section>
  <h2>Seed</h2>
  <button id="seed-seller">Seed seller</button>
  <button id="seed-store">Seed store owner</button>
  <button id="seed-grant-pending">Seed grant pending</button>
  <button id="seed-grant-approved">Seed grant approved</button>
  <button id="seed-grant-rejected">Seed grant rejected</button>
  <button id="seed-clear">Clear all</button>
</section>
<pre id="out"></pre>
<script>
(function () {
  var out = document.getElementById('out');
  function log(msg) { out.textContent += msg + '\\n'; }
  function api() { return fetch('/__rig/state').then(function (r) { return r.json(); }); }

  document.getElementById('apply').addEventListener('click', function () {
    var body = { scenario: document.getElementById('scenario').value, latencyMs: Number(document.getElementById('latency').value) };
    fetch('/__rig/state', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) { return r.json(); })
      .then(function (s) { log('state: ' + JSON.stringify(s)); });
  });

  var OWNER = 'gikomart_ownerToken:';
  var STORE = 'gikomart_storeToken:';

  document.getElementById('seed-seller').addEventListener('click', function () {
    ['rig-l-01', 'rig-l-02', 'rig-l-03'].forEach(function (id) { localStorage.setItem(OWNER + id, 'rig-token'); });
    log('wrote ' + OWNER + 'rig-l-01..03 = "rig-token" (3 keys)');
  });

  document.getElementById('seed-store').addEventListener('click', function () {
    localStorage.setItem(STORE + 'rig-s-1', 'rig-token');
    log('wrote ' + STORE + 'rig-s-1 = "rig-token"');
  });

  var META = { type: 'listing', whatsapp: '0712345678', plan: 'Standard (7 days)' };
  function seedGrant(claimId) {
    localStorage.setItem('gikomart_grantToken:' + claimId, 'rig-token');
    localStorage.setItem('gikomart_grantMeta:' + claimId, JSON.stringify(META));
    log('wrote gikomart_grantToken:' + claimId + ' and gikomart_grantMeta:' + claimId + ' = ' + JSON.stringify(META));
  }
  document.getElementById('seed-grant-pending').addEventListener('click', function () { seedGrant('rig-claim-pending'); });
  document.getElementById('seed-grant-approved').addEventListener('click', function () { seedGrant('rig-claim-approved'); });
  document.getElementById('seed-grant-rejected').addEventListener('click', function () { seedGrant('rig-claim-rejected'); });

  document.getElementById('seed-clear').addEventListener('click', function () {
    var removed = [];
    for (var i = localStorage.length - 1; i >= 0; i--) {
      var k = localStorage.key(i);
      if (k && k.indexOf('gikomart_') === 0) { removed.push(k); localStorage.removeItem(k); }
    }
    log('removed ' + removed.length + ' gikomart_ keys');
  });

  api().then(function (s) { log('current state: ' + JSON.stringify(s)); });
})();
</script>
</body>
</html>`;
}

app.get('/__rig', (req, res) => res.redirect('/__rig/'));

const PORT = Number(process.env.RIG_PORT) || 4173;
app.listen(PORT, '127.0.0.1', () => {
  console.log(`[rig] GikoMart UI rig on http://127.0.0.1:${PORT}/  (control page: /__rig/)`);
  console.log('[rig] The rig never imports src/ and never touches a database.');
});
