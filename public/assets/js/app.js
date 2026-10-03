/* ============================================
   GikoMart Frontend — app.js
   Connects to the Express + MongoDB backend
   ============================================ */

// Same-origin: Express serves both the SPA (express.static('public')) and the
// /api routes, so the API base is always the page's origin — no hard-coded
// host or port. Works on localhost, Render, or any dev port.
const API_BASE = '/api';

// Ownership tokens: after a listing payment completes, the server hands back a
// one-time owner token. It is stored only in this browser (localStorage) and
// sent back as X-Owner-Token on edit/delete. Before the listing's id is known,
// the token waits keyed by the payment's invoiceId ("pending"), then is
// re-keyed to the listing id once the status poll reveals it.
const OWNER_TOKEN_PREFIX = 'gikomart_ownerToken:';
const PENDING_TOKEN_PREFIX = 'gikomart_pendingToken:';
// Exponential backoff for payment-status polling: the first check runs
// immediately, then these delays separate the remaining attempts (2+4+8+16+32
// = 62s). Once the sequence is exhausted the flow hands off to a manual
// Recovery state instead of continuing to hammer the endpoint.
const STATUS_POLL_BACKOFF_MS = [2000, 4000, 8000, 16000, 32000];
const STATUS_POLL_MAX_ATTEMPTS = STATUS_POLL_BACKOFF_MS.length; // 5
// Transient-failure backoff for the Cloudinary upload (network / 5xx / timeout).
const UPLOAD_RETRY_DELAYS_MS = [1000, 2000, 4000];

const CATEGORIES = [
  { id: 'elec',  name: 'Electronics',     icon: '📱' },
  { id: 'furn',  name: 'Furniture',       icon: '🛋️' },
  { id: 'cloth', name: 'Clothing',        icon: '👕' },
  { id: 'auto',  name: 'Vehicles',        icon: '🚗' },
  { id: 'prop',  name: 'Property',        icon: '🏠' },
  { id: 'job',   name: 'Jobs & Services', icon: '💼' },
  { id: 'agri',  name: 'Agriculture',     icon: '🌾' },
  { id: 'essn',  name: 'Student Essentials', icon: '📚' },
  { id: 'host',  name: 'Hostel Living',   icon: '🛏️' },
  { id: 'free',  name: 'Free Stuff',      icon: '🎁' },
];

const DEMO_LISTINGS = [
  { _id: 'demo1', title: 'Samsung Galaxy S22', category: 'Electronics', condition: 'Excellent', price: 38000, description: '128GB, no cracks, charger included.', location: 'Njoro', sellerName: 'Brian', sellerWhatsapp: '+254712345678', views: 42, icon: '📱', broadcastSent: true },
  { _id: 'demo2', title: 'Study Desk + Chair', category: 'Furniture', condition: 'Good', price: 6500, description: 'Wooden desk, adjustable chair. Minor scratches.', location: 'Nakuru CBD', sellerName: 'Grace', sellerWhatsapp: '+254723456789', views: 19, icon: '🛋️', broadcastSent: true },
  { _id: 'demo3', title: 'Calculus Textbook Bundle', category: 'Student Essentials', condition: 'Good', price: 1200, description: 'MATH 111 + 112 textbooks plus past papers.', location: 'Egerton Uni', sellerName: 'Kevin', sellerWhatsapp: '+254734567890', views: 31, icon: '📚', broadcastSent: true },
  { _id: 'demo4', title: 'Mattress — 4x6', category: 'Hostel Living', condition: 'Like New', price: 3500, description: 'Used one semester only, no stains.', location: 'Hostel C', sellerName: 'James', sellerWhatsapp: '+254745678901', views: 88, icon: '🛏️', broadcastSent: true },
  { _id: 'demo5', title: 'Maize — 2 bags 90kg', category: 'Agriculture', condition: 'New', price: 9000, description: 'Freshly harvested, dry. Ready for collection.', location: 'Njoro', sellerName: 'Wanjiru', sellerWhatsapp: '+254756789012', views: 14, icon: '🌾', broadcastSent: false },
  { _id: 'demo6', title: 'Leather Jacket', category: 'Clothing', condition: 'Like New', price: 2800, description: 'Medium size, worn twice only.', location: 'Egerton Uni', sellerName: 'Kevin', sellerWhatsapp: '+254734567890', views: 31, icon: '👕', broadcastSent: true },
];

const CATEGORY_ICONS = {
  'Electronics': '📱', 'Furniture': '🛋️', 'Clothing': '👕', 'Vehicles': '🚗',
  'Property': '🏠', 'Jobs & Services': '💼', 'Agriculture': '🌾',
  'Student Essentials': '📚', 'Hostel Living': '🛏️', 'Free Stuff': '🎁',
};

const BOOST_OPTIONS = [
  { id: 'featured', label: 'Featured (24h)', desc: 'Pin to top of category & search', price: 50 },
  { id: 'rush', label: 'Semester Rush Boost (72h)', desc: 'Top placement during move-out rush', price: 80 },
  { id: 'priority_broadcast', label: 'Priority Broadcast', desc: 'Extra WhatsApp broadcast at peak hours', price: 30 },
];

// ─── Store constants ────────────────────────────────────────────────────────
const STORE_OWNER_TOKEN_PREFIX = 'gikomart_storeToken:';

const STORE_CATEGORIES = [
  { id: 'fashion', name: 'Fashion & Accessories', icon: '👗' },
  { id: 'electronics', name: 'Electronics & Technology', icon: '💻' },
  { id: 'academic', name: 'Academic', icon: '📖' },
  { id: 'food', name: 'Food & Groceries', icon: '🍎' },
  { id: 'beauty', name: 'Beauty & Personal Care', icon: '💄' },
  { id: 'home', name: 'Home & Living', icon: '🏠' },
  { id: 'services', name: 'Services', icon: '🔧' },
  { id: 'creative', name: 'Creative & Events', icon: '🎨' },
  { id: 'accommodation', name: 'Accommodation', icon: '🛏️' },
  { id: 'transport', name: 'Transport & Delivery', icon: '🚗' },
  { id: 'rentals', name: 'Rentals', icon: '🔑' },
  { id: 'other', name: 'Other', icon: '📦' },
];

const STORE_PLANS = [
  { id: 'starter_weekly', label: 'Starter Weekly', price: 150, duration: '1 week', maxListings: 5 },
  // standard_weekly removed (audit Fix 6): same price/limit as Standard Monthly
  // but dominated by it — the backend no longer accepts it, so offering it in
  // the UI would let users select a plan the payment API rejects.
  { id: 'standard_monthly', label: 'Standard Monthly', price: 200, duration: '1 month', maxListings: 10 },
  { id: 'pro_monthly', label: 'Pro Monthly', price: 300, duration: '1 month', maxListings: 15 },
];

let allListings = [];
let myListings = [];
let activeCategory = '';
let usingDemoData = false;
let uploadedImageUrl = null;
let browseFetchFailed = false;   // last /listings fetch failed → show retry banner
let browseFetchErrorMsg = '';    // friendly message for that failure
let gridRequestId = 0;           // increments per fetch; stale responses are dropped
let isUploading = false;         // a Cloudinary upload is in flight
let isPaymentInFlight = false;   // an M-Pesa initiate/poll is in progress
let listingPollTimer = null;     // pending listing-status poll retry timer
let storePollTimer = null;       // pending store-status poll retry timer

let TERMS_VERSIONS = null;

async function loadTermsVersions() {
  try {
    const res = await fetch(`${API_BASE}/terms/versions`);
    if (res.ok) {
      const data = await res.json();
      if (data && data.success) TERMS_VERSIONS = data.versions;
    }
  } catch (_e) { /* fall back to defaults */ }
  if (!TERMS_VERSIONS) {
    TERMS_VERSIONS = {
      GIKOMART_TERMS_OF_SERVICE: '1.0.0',
      STORE_OWNER_TERMS: '1.0.0',
      SELLER_TERMS: '1.0.0',
      BUYER_TERMS: '1.0.0',
    };
  }
}

function sellerListingAcceptanceHTML() {
  const sellerVer = TERMS_VERSIONS.SELLER_TERMS;
  const tosVer = TERMS_VERSIONS.GIKOMART_TERMS_OF_SERVICE;
  return `
    <div class="terms-acceptance" data-terms-type="listing-publication">
      <p class="terms-statement">
        By clicking <strong>Pay &amp; Publish</strong>, I confirm that I have the right to offer this item/service and accept responsibility for this listing. I agree to the
        <a href="/legal/seller-terms.html" target="_blank" rel="noopener" class="terms-link">Seller Terms &amp; Conditions</a>
        <span class="terms-version">v${sellerVer}</span> and the
        <a href="/legal/terms-of-service.html" target="_blank" rel="noopener" class="terms-link">GikoMart Terms of Service</a>
        <span class="terms-version">v${tosVer}</span>.
      </p>
    </div>`;
}

function storeCreationAcceptanceHTML() {
  const storeVer = TERMS_VERSIONS.STORE_OWNER_TERMS;
  const tosVer = TERMS_VERSIONS.GIKOMART_TERMS_OF_SERVICE;
  return `
    <div class="terms-acceptance" data-terms-type="store-creation">
      <p class="terms-statement">
        By clicking <strong>Create Store</strong>, I confirm that I accept responsibility for this Store and everything published through it. I agree to the
        <a href="/legal/store-owner-terms.html" target="_blank" rel="noopener" class="terms-link">Store Owner Terms &amp; Conditions</a>
        <span class="terms-version">v${storeVer}</span> and the
        <a href="/legal/terms-of-service.html" target="_blank" rel="noopener" class="terms-link">GikoMart Terms of Service</a>
        <span class="terms-version">v${tosVer}</span>.
      </p>
    </div>`;
}

function buyerContactAcceptanceHTML() {
  const buyerVer = TERMS_VERSIONS.BUYER_TERMS;
  const tosVer = TERMS_VERSIONS.GIKOMART_TERMS_OF_SERVICE;
  return `
    <div class="terms-acceptance" data-terms-type="buyer-contact">
      <p class="terms-statement">
        By clicking <strong>Continue &amp; Contact Seller</strong>, I acknowledge that GikoMart is an introduction platform, understand the risks of dealing with another user, and agree to the
        <a href="/legal/buyer-terms.html" target="_blank" rel="noopener" class="terms-link">Buyer Terms &amp; Conditions</a>
        <span class="terms-version">v${buyerVer}</span> and the
        <a href="/legal/terms-of-service.html" target="_blank" rel="noopener" class="terms-link">GikoMart Terms of Service</a>
        <span class="terms-version">v${tosVer}</span>.
      </p>
    </div>`;
}

function buildSellerAcceptanceToken() {
  return {
    accepted: true,
    gikomartTermsVersion: TERMS_VERSIONS.GIKOMART_TERMS_OF_SERVICE,
    sellerTermsVersion: TERMS_VERSIONS.SELLER_TERMS,
    action: 'PAY_AND_PUBLISH',
  };
}

function buildStoreAcceptanceToken() {
  return {
    accepted: true,
    gikomartTermsVersion: TERMS_VERSIONS.GIKOMART_TERMS_OF_SERVICE,
    storeOwnerTermsVersion: TERMS_VERSIONS.STORE_OWNER_TERMS,
    action: 'CREATE_STORE',
  };
}

function buildBuyerAcceptanceToken() {
  return {
    accepted: true,
    gikomartTermsVersion: TERMS_VERSIONS.GIKOMART_TERMS_OF_SERVICE,
    buyerTermsVersion: TERMS_VERSIONS.BUYER_TERMS,
    action: 'CONTINUE_AND_CONTACT_SELLER',
  };
}

document.addEventListener('DOMContentLoaded', async () => {
  if (document.getElementById('footerYear')) {
    document.getElementById('footerYear').textContent = String(new Date().getFullYear());
  }
  // Must be awaited: every init step below can render a terms-acceptance
  // notice (sell form, store modal), and a floating call left TERMS_VERSIONS
  // null — the resulting TypeError aborted the rest of the init chain on cold
  // load (store modal + delegated actions + listings never initialized).
  await loadTermsVersions();
  buildCategoryPills();
  buildCategorySelect();
  buildPulseTicker();
  setupNav();
  setupForm();
  setupModal();
  setupStoreModal();
  setupReportModal();
  setupActionDelegation();
  loadListings();
  recoverPendingTokens();
  // Abort any in-flight status poll when the page is torn down (tab close or
  // navigation) so a stale timer can't fire against a gone page.
  window.addEventListener('pagehide', () => { clearListingPoll(); clearStorePoll(); });
});

function setupNav() {
  document.querySelectorAll('[data-view]').forEach(el => {
    el.addEventListener('click', () => switchView(el.dataset.view));
  });
}

// Grid retry lives in the same delegation system as every other action
// (setupActionDelegation below) — main's parallel setupDelegatedClicks/
// attachOwnerButtons system was merged away in favor of the single
// data-action delegation so no control can ever fire twice.
function switchView(view) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.querySelectorAll('.nav-link').forEach(n => n.classList.remove('active'));
  document.getElementById('view-' + view).classList.add('active');
  document.querySelectorAll(`.nav-link[data-view="${view}"]`).forEach(n => n.classList.add('active'));

  if (view === 'dashboard') renderDashboard();
  if (view === 'mystore') renderMyStore();
  window.scrollTo({ top: document.querySelector('.app-shell').offsetTop - 20, behavior: 'smooth' });
}

function buildCategoryPills() {
  const container = document.getElementById('catPills');
  const allPill = document.createElement('button');
  allPill.className = 'cat-pill active';
  allPill.textContent = 'All';
  allPill.addEventListener('click', () => filterByCategory('', allPill));
  container.appendChild(allPill);

  CATEGORIES.forEach(cat => {
    const pill = document.createElement('button');
    pill.className = 'cat-pill';
    pill.innerHTML = `${cat.icon} ${cat.name}`;
    pill.addEventListener('click', () => filterByCategory(cat.name, pill));
    container.appendChild(pill);
  });

  document.getElementById('searchInput').addEventListener('input', renderListings);
}

function buildCategorySelect() {
  const select = document.getElementById('f-category');
  CATEGORIES.forEach(cat => {
    const opt = document.createElement('option');
    opt.value = cat.name;
    opt.textContent = `${cat.icon} ${cat.name}`;
    select.appendChild(opt);
  });
  document.getElementById('statCats').textContent = CATEGORIES.length;
}

function filterByCategory(catName, el) {
  activeCategory = catName;
  document.querySelectorAll('.cat-pill').forEach(p => p.classList.remove('active'));
  el.classList.add('active');
  renderListings();
}

function buildPulseTicker() {
  const items = [
    { item: 'Samsung Galaxy S22', dest: 'Electronics group + Campus Channel' },
    { item: 'Mattress — 4x6', dest: 'Hostel Living group' },
    { item: 'Calculus Textbook Bundle', dest: 'Student Essentials group' },
    { item: 'Study Desk + Chair', dest: 'Furniture group + Campus Channel' },
    { item: 'Leather Jacket', dest: 'Clothing group' },
  ];
  const track = document.getElementById('pulseTrack');
  const html = [...items, ...items].map(i => `
    <span class="pulse-item">
      <span class="pulse-dot"></span>
      📢 Just posted: <strong>${i.item}</strong>
      <span class="pulse-arrow">→</span> sent to ${i.dest}
    </span>
  `).join('');
  track.innerHTML = html;
}

// ---- Owner token storage --------------------------------------------------

function saveOwnerToken(listingId, token) {
  try { localStorage.setItem(OWNER_TOKEN_PREFIX + listingId, token); } catch (err) { console.warn('Could not save owner token:', err); }
}

function getOwnerToken(listingId) {
  try { return localStorage.getItem(OWNER_TOKEN_PREFIX + listingId); } catch (err) { return null; }
}

function hasOwnerToken(listingId) {
  return Boolean(getOwnerToken(listingId));
}

// ─── Store token storage ────────────────────────────────────────────────────

function saveStoreToken(storeId, token) {
  try { localStorage.setItem(STORE_OWNER_TOKEN_PREFIX + storeId, token); } catch (err) {}
}

function getStoreToken(storeId) {
  try { return localStorage.getItem(STORE_OWNER_TOKEN_PREFIX + storeId); } catch (err) { return null; }
}

function getAllMyStoreIds() {
  const ids = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith(STORE_OWNER_TOKEN_PREFIX)) {
        ids.push(key.slice(STORE_OWNER_TOKEN_PREFIX.length));
      }
    }
  } catch (err) {}
  return ids;
}

// Move a pending token (keyed by invoiceId) onto its listing id once the
// status endpoint reveals which listing the payment created.
function adoptPendingToken(invoiceId, listingId) {
  let token = null;
  try { token = localStorage.getItem(PENDING_TOKEN_PREFIX + invoiceId); } catch (err) {}
  if (!token) return;
  saveOwnerToken(listingId, token);
  try { localStorage.removeItem(PENDING_TOKEN_PREFIX + invoiceId); } catch (err) {}
}

// After payment completes, the webhook creates the listing server-side. Poll
// the status endpoint until it reports the new listing id, then re-key the
// saved token so edit/delete controls appear for that listing.
function pollListingStatus(invoiceId, attempt = 0) {
  if (attempt >= STATUS_POLL_MAX_ATTEMPTS) {
    // The automatic polling window is exhausted, but the webhook can still land
    // later. Release the publish button (don't leave it disabled forever) and
    // switch to a persistent Recovery state that shows the invoice reference and
    // offers a manual re-check.
    if (isPaymentInFlight) {
      isPaymentInFlight = false;
      setBtnBusy(document.getElementById('submitBtn'), false);
    }
    showPaymentRecovery(document.getElementById('formStatus'), invoiceId, () => checkListingStatusManually(invoiceId));
    return;
  }
  fetch(`${API_BASE}/payments/status/${encodeURIComponent(invoiceId)}`)
    .then(res => (res.ok ? res.json() : null))
    .then(data => {
      if (data && data.success && data.listingId) {
        adoptPendingToken(invoiceId, data.listingId);
        showToast('✅ Payment confirmed — your listing is live!');
        if (isPaymentInFlight) endPaymentWait(true, '✅ Payment confirmed — your listing is live!');
        loadListings();
        return;
      }
      if (data && data.success && data.status === 'failed') {
        try { localStorage.removeItem(PENDING_TOKEN_PREFIX + invoiceId); } catch (err) {}
        showToast('❌ Payment failed — nothing was listed');
        if (isPaymentInFlight) endPaymentWait(false, '❌ Payment failed — nothing was listed. Try again.');
        return;
      }
      listingPollTimer = setTimeout(() => pollListingStatus(invoiceId, attempt + 1), pollBackoffDelay(attempt));
    })
    .catch(() => {
      listingPollTimer = setTimeout(() => pollListingStatus(invoiceId, attempt + 1), pollBackoffDelay(attempt));
    });
}

// Delay before the next poll attempt: walk the backoff sequence, capping at
// its last entry so a mis-set attempt can never index past the array.
function pollBackoffDelay(attempt) {
  return STATUS_POLL_BACKOFF_MS[Math.min(attempt, STATUS_POLL_BACKOFF_MS.length - 1)];
}

// Cancel a scheduled status-poll retry. Each flow keeps a single timer, so a
// closed modal (store) or a torn-down page never leaves one running.
function clearListingPoll() {
  if (listingPollTimer) { clearTimeout(listingPollTimer); listingPollTimer = null; }
}
function clearStorePoll() {
  if (storePollTimer) { clearTimeout(storePollTimer); storePollTimer = null; }
}

// Persistent Recovery state for a payment whose automatic poll window expired.
// Shows the invoiceId — the only reference the client can quote to support —
// and a button that runs ONE manual status check, because the webhook may
// still land after the polls stop.
function showPaymentRecovery(statusEl, invoiceId, onManualCheck) {
  if (!statusEl) return;
  statusEl.className = 'form-status';
  statusEl.innerHTML =
    `⏳ Payment is still processing. Reference: <strong>${escapeHTML(invoiceId)}</strong>. ` +
    `If it doesn't appear in 2 minutes, click below to check again.` +
    `<button type="button" class="btn btn-primary" data-manual-check style="margin-top:8px;">Check Status Now</button>`;
  const btn = statusEl.querySelector('[data-manual-check]');
  if (btn) {
    btn.addEventListener('click', () => {
      btn.disabled = true;
      btn.textContent = 'Checking…';
      onManualCheck();
    });
  }
}

// One manual status check for a listing payment in Recovery. Confirmation
// transitions to the Success state; still-pending points the user at support
// with the reference.
async function checkListingStatusManually(invoiceId) {
  const statusEl = document.getElementById('formStatus');
  let data;
  try {
    const res = await fetch(`${API_BASE}/payments/status/${encodeURIComponent(invoiceId)}`);
    if (!res.ok) throw httpError(res, null);
    data = await res.json();
  } catch (err) {
    if (statusEl) {
      statusEl.className = 'form-status error';
      statusEl.textContent = friendlyFetchError(err);
    }
    return;
  }

  if (data && data.success && data.listingId) {
    adoptPendingToken(invoiceId, data.listingId);
    showToast('✅ Payment confirmed — your listing is live!');
    endPaymentWait(true, '✅ Payment confirmed — your listing is live!');
    loadListings();
    return;
  }
  if (data && data.success && data.status === 'failed') {
    try { localStorage.removeItem(PENDING_TOKEN_PREFIX + invoiceId); } catch (err) {}
    showToast('❌ Payment failed — nothing was listed');
    endPaymentWait(false, '❌ Payment failed — nothing was listed. Try again.');
    return;
  }
  if (statusEl) {
    statusEl.className = 'form-status error';
    statusEl.textContent = `Still processing. Please contact support with reference: ${invoiceId}.`;
  }
}

// One-time recovery for tokens left pending by a closed tab (e.g. the user
// navigated away before the payment webhook landed).
function recoverPendingTokens() {
  const pendingInvoiceIds = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith(PENDING_TOKEN_PREFIX)) {
        pendingInvoiceIds.push(key.slice(PENDING_TOKEN_PREFIX.length));
      }
    }
  } catch (err) { return; }
  pendingInvoiceIds.forEach(invoiceId => {
    fetch(`${API_BASE}/payments/status/${encodeURIComponent(invoiceId)}`)
      .then(res => (res.ok ? res.json() : null))
      .then(data => {
        if (data && data.success && data.listingId) adoptPendingToken(invoiceId, data.listingId);
        if (data && data.success && data.storeId) {
          let token = null;
          try { token = localStorage.getItem(PENDING_TOKEN_PREFIX + invoiceId); } catch (err) {}
          if (token) {
            saveStoreToken(data.storeId, token);
            try { localStorage.removeItem(PENDING_TOKEN_PREFIX + invoiceId); } catch (err) {}
          }
        }
      })
      .catch(() => {});
  });
}

async function loadListings() {
  const grid = document.getElementById('listingGrid');
  const requestId = ++gridRequestId;
  showGridSkeleton(grid);

  try {
    const res = await fetch(`${API_BASE}/listings`);
    if (requestId !== gridRequestId) return; // superseded by a newer fetch
    if (!res.ok) throw httpError(res, null);
    const data = await res.json();
    allListings = data.listings.map(l => ({
      ...l,
      icon: CATEGORY_ICONS[l.category] || '📦',
    }));
    usingDemoData = false;
    browseFetchFailed = false;
  } catch (err) {
    if (requestId !== gridRequestId) return;
    console.warn('API not reachable — showing demo listings:', err.message);
    allListings = DEMO_LISTINGS;
    usingDemoData = true;
    browseFetchFailed = true;
    browseFetchErrorMsg = friendlyFetchError(err);
  }
  myListings = allListings.filter(l => hasOwnerToken(l._id));
  document.getElementById('statListings').textContent = allListings.length;
  renderListings();
}

// Render a row of shimmer skeleton cards matching the real card layout
// (image block, title line, price line, meta line) so nothing shifts when
// the actual listings load in. Used for the initial fetch and any re-fetch.
function showGridSkeleton(grid, count = 8) {
  const placeholders = Array.from({ length: count }, () => `
    <div class="skeleton-card" aria-hidden="true">
      <div class="skeleton sk-img"></div>
      <div class="sk-body">
        <div class="skeleton sk-title"></div>
        <div class="skeleton sk-price"></div>
        <div class="skeleton sk-meta"></div>
      </div>
    </div>`).join('');
  grid.innerHTML = placeholders;
  grid.setAttribute('aria-busy', 'true');
}

// Busy state for a button: disable it and drop in an inline spinner while an
// async request runs. The original label is remembered on first use so a call
// with busy=false restores it exactly (innerHTML, so any embedded markup is
// kept). Pass busyLabel to swap the text while busy — e.g. the publish button's
// "Sending payment request…" → "Waiting for M-Pesa confirmation…".
function setBtnBusy(btn, busy, busyLabel) {
  if (!btn) return;
  if (busy) {
    if (!btn.dataset.origLabel) btn.dataset.origLabel = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<span class="btn-spinner" aria-hidden="true"></span>' + (busyLabel || btn.dataset.origLabel);
  } else {
    btn.disabled = false;
    if ('origLabel' in btn.dataset) {
      btn.innerHTML = btn.dataset.origLabel;
      delete btn.dataset.origLabel;
    } else {
      const sp = btn.querySelector('.btn-spinner');
      if (sp) sp.remove();
    }
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Upload the image with exponential backoff on TRANSIENT failures only — a
// network error (fetch rejects), a 5xx, or a timeout. A 4xx is a file/input
// problem, so it is returned at once (retrying cannot help). The caller's
// status line shows the transient message the moment a retryable failure is
// seen, so the user is not left on a blank "Uploading…" for the whole window;
// a later success overwrites it.
async function fetchUploadWithRetry(formData, statusEl) {
  for (let attempt = 0; ; attempt++) {
    let res = null;
    let networkErr = null;
    try {
      res = await fetch(`${API_BASE}/upload`, { method: 'POST', body: formData });
    } catch (err) {
      networkErr = err;
    }
    const retryable = networkErr !== null || (res && res.status >= 500);
    if (!retryable) return res;
    if (attempt >= UPLOAD_RETRY_DELAYS_MS.length) {
      if (networkErr) throw networkErr;
      return res;
    }
    if (statusEl) {
      statusEl.textContent = networkErr
        ? "📡 Couldn't connect. Retrying…"
        : 'Server is busy — please try again in a moment';
      statusEl.className = 'image-upload-status error';
    }
    await sleep(UPLOAD_RETRY_DELAYS_MS[attempt]);
  }
}

// Map a failed fetch to a friendly, scenario-specific message. The HTTP status
// is attached to the thrown Error by the call site (httpError); an Error with
// no status means the request never reached the server (offline/DNS/CORS).
function friendlyFetchError(err) {
  const status = err && typeof err.status === 'number' ? err.status : null;
  if (status === null) return "📡 Couldn't connect. Check your internet and try again.";
  if (status === 503) return '⏳ Server is busy. Please wait a moment and try again.';
  if (status === 400 || status === 422) return '⚠️ Please check your input and try again.';
  if (status >= 500) return '⚠️ Something went wrong on our end. Please try again in a minute.';
  // Any other status whose response carried a server message: that message is
  // already specific and actionable, so surface it rather than a catch-all.
  if (err.serverError) return `⚠️ ${err.serverError}`;
  return '⚠️ Unexpected error. Please refresh the page and try again.';
}

// Wrap a non-2xx Response in an Error carrying the status (and the server's own
// message) so friendlyFetchError can pick the right string at the catch site.
function httpError(res, data) {
  const err = new Error((data && data.error) || `Request failed (HTTP ${res.status})`);
  err.status = res.status;
  err.serverError = data && data.error ? data.error : '';
  return err;
}

function renderListings() {
  const search = document.getElementById('searchInput').value.toLowerCase();
  const filtered = allListings.filter(l => {
    const matchCat = !activeCategory || l.category === activeCategory;
    const matchSearch = !search ||
      l.title.toLowerCase().includes(search) ||
      l.description.toLowerCase().includes(search);
    return matchCat && matchSearch;
  });

  filtered.sort((a, b) => (b.featured ? 1 : 0) - (a.featured ? 1 : 0));

  const grid = document.getElementById('listingGrid');
  grid.removeAttribute('aria-busy');

  // Error affordance: keep the demo listings visible (the site stays usable)
  // but make the failure obvious and let the user retry the real fetch.
  if (!filtered.length) {
    const errorBanner = browseFetchFailed
      ? `<div class="grid-error"><span>${escapeHTML(browseFetchErrorMsg)} — showing sample listings.</span><button type="button" class="grid-retry-btn">↻ Retry</button></div>`
      : '';
    grid.innerHTML = errorBanner + `
      <div class="empty-state">
        <span class="empty-icon">🔍</span>
        <p><strong>Nothing here yet.</strong></p>
        <p>Try a different search or category — or be the first to list one.</p>
      </div>`;
    return;
  }

  const errorBanner = browseFetchFailed
    ? `<div class="grid-error"><span>${escapeHTML(browseFetchErrorMsg)} — showing sample listings.</span><button type="button" class="grid-retry-btn">↻ Retry</button></div>`
    : '';

  grid.innerHTML = errorBanner + filtered.map(l => listingCardHTML(l)).join('');

  grid.querySelectorAll('.listing-card').forEach(card => {
    card.addEventListener('click', () => openListingModal(card.dataset.id, filtered));
  });
}

function listingCardHTML(l) {
  const condClass = 'cond-' + String(l.condition).replace(/\s+/g, '-');
  const hasImage = l.images && l.images.length > 0;
  const imageContent = hasImage
    ? `<img src="${escapeAttr(cloudinaryResize(l.images[0], 'w_400,h_400,c_fill,q_auto,f_auto'))}" alt="${escapeAttr(l.title)}" loading="lazy">`
    : l.icon;
  const badgeHTML = l.featured
    ? `<span class="featured-badge ${l.boostType === 'rush' ? 'rush-badge' : ''}">⭐ ${l.boostType === 'rush' ? 'Rush Boost' : 'Featured'}</span>`
    : '';
  const storeBadgeHTML = l.store_name
    ? `<span class="store-badge" data-action="open-store-page" data-slug="${escapeAttr(l.store_slug)}" data-stop="1">🏪 ${escapeHTML(l.store_name)}</span>`
    : '';
  // Only listings this browser holds an owner token for get edit/delete controls.
  const owned = !usingDemoData && hasOwnerToken(l._id);
  const ownerControlsHTML = owned ? `
        <div class="owner-controls">
          <button class="owner-btn edit" data-action="edit-listing" data-listing-id="${l._id}" data-stop="1">✏️ Edit</button>
          <button class="owner-btn delete" data-action="delete-listing" data-listing-id="${l._id}" data-stop="1">🗑️ Delete</button>
        </div>` : '';
  return `
    <div class="listing-card" data-id="${escapeAttr(l._id)}">
      <div class="listing-image">
        ${imageContent}
        ${badgeHTML}
        <span class="condition-badge ${escapeAttr(condClass)}">${escapeHTML(l.condition)}</span>
      </div>
      <div class="listing-body">
        ${storeBadgeHTML}
        <div class="listing-title">${escapeHTML(l.title)}</div>
        <div class="listing-price">KSh ${Number(l.price).toLocaleString()}</div>
        <div class="listing-meta">
          <span>📍 ${escapeHTML(l.location || 'Egerton')}</span>
          ${l.broadcastSent ? '<span class="broadcast-chip">📢 Broadcast</span>' : `<span>👁️ ${l.views || 0}</span>`}
        </div>
        ${ownerControlsHTML}
      </div>
    </div>`;
}

function setupModal() {
  document.getElementById('modalOverlay').addEventListener('click', (e) => {
    if (e.target.id === 'modalOverlay') closeModal();
  });
  // Delegated handler for the modal's interactive elements (contact button and
  // the owner edit/delete buttons). They carry their data in attributes —
  // never in inline JS strings — so user-controlled values can't break out
  // into executable JS (stored XSS), and no inline onclick is needed (the
  // hardened CSP blocks inline handlers). The modalCard element persists across
  // renders — only its innerHTML is replaced — so this single listener works
  // for every listing modal.
  document.getElementById('modalCard').addEventListener('click', (e) => {
    const ownerBtn = e.target.closest('.owner-btn');
    if (ownerBtn) {
      const id = ownerBtn.dataset.listing;
      if (!id) return;
      if (ownerBtn.classList.contains('edit')) editListing(id);
      else deleteListing(id);
      return;
    }
    const btn = e.target.closest('.contact-btn');
    if (!btn) return;
    contactSeller(btn.dataset.title || '', btn.dataset.listingId || '');
  });
}

function openListingModal(id, source) {
  const listing = (source || allListings).find(l => l._id === id);
  if (!listing) return;

  const condClass = 'cond-' + String(listing.condition).replace(/\s+/g, '-');
  const hasImage = listing.images && listing.images.length > 0;
  const modalImageContent = hasImage
    ? `<img src="${escapeAttr(cloudinaryResize(listing.images[0], 'w_800,q_auto,f_auto'))}" alt="${escapeAttr(listing.title)}" style="width:100%;height:100%;object-fit:cover;">`
    : (listing.icon || CATEGORY_ICONS[listing.category] || '📦');
  const card = document.getElementById('modalCard');
  card.innerHTML = `
    <button class="modal-close" data-action="close-modal">✕</button>
    <div class="modal-image">${modalImageContent}</div>
    <span class="condition-badge ${escapeAttr(condClass)}">${escapeHTML(listing.condition)}</span>
    <h3 style="font-family:var(--font-display); font-size:20px; margin:10px 0 4px;">${escapeHTML(listing.title)}</h3>
    <div class="modal-price">KSh ${Number(listing.price).toLocaleString()}</div>
    <div class="modal-meta-row">
      <span>📂 ${escapeHTML(listing.category)}</span>
      <span>📍 ${escapeHTML(listing.location || 'Egerton')}</span>
      <span>👤 ${escapeHTML(listing.sellerName)}</span>
      <span>👁️ ${listing.views || 0} views</span>
    </div>
    <p class="modal-desc">${escapeHTML(listing.description)}</p>
    <button class="contact-btn" data-whatsapp="${escapeAttr(listing.sellerWhatsapp)}" data-title="${escapeAttr(listing.title)}" data-listing-id="${listing._id}">
      💬 Contact seller on WhatsApp
    </button>
    ${usingDemoData ? '' : `<button class="btn btn-ghost btn-sm" data-action="report-listing" data-target-id="${escapeAttr(listing._id)}" style="margin-top:10px;">🚩 Report</button>`}
    ${!usingDemoData && hasOwnerToken(listing._id) ? `
    <div class="owner-controls">
      <button class="owner-btn edit" data-action="edit-listing" data-listing-id="${listing._id}">✏️ Edit listing</button>
      <button class="owner-btn delete" data-action="delete-listing" data-listing-id="${listing._id}">🗑️ Delete listing</button>
    </div>` : ''}
    ${listing.featured || usingDemoData || !hasOwnerToken(listing._id) ? '' : boostSectionHTML(listing._id)}
  `;
  document.getElementById('modalOverlay').classList.add('open');
}

function closeModal() {
  document.getElementById('modalOverlay').classList.remove('open');
}

function setupStoreModal() {
  document.getElementById('storeModalOverlay').addEventListener('click', (e) => {
    if (e.target.id === 'storeModalOverlay') closeStoreModal();
  });
  // The store creation form is re-innerHTML'd into the persistent card, so a
  // delegated submit listener here survives every render (same pattern as the
  // listing modal's contact-button delegation). Avoids an inline onsubmit,
  // which the CSP blocks just like inline onclick.
  document.getElementById('storeModalCard').addEventListener('submit', (e) => {
    if (e.target.id !== 'storeCreationForm') return;
    handleStorePlanSubmit(e);
  });
}

// ─── Report modal ───────────────────────────────────────────────────────────

function setupReportModal() {
  const overlay = document.getElementById('reportModalOverlay');
  if (!overlay) return;
  // Same overlay-click-to-close pattern as the listing/store modals.
  overlay.addEventListener('click', (e) => {
    if (e.target.id === 'reportModalOverlay') closeReportModal();
  });
  const form = document.getElementById('reportForm');
  if (form) form.addEventListener('submit', handleReportSubmit);
}

function openReportModal(targetType, targetId) {
  const typeEl = document.getElementById('report-target-type');
  const idEl = document.getElementById('report-target-id');
  if (!typeEl || !idEl) return;
  typeEl.value = targetType || '';
  idEl.value = targetId || '';

  const form = document.getElementById('reportForm');
  if (form) form.reset();
  const statusEl = document.getElementById('reportFormStatus');
  if (statusEl) { statusEl.textContent = ''; statusEl.className = 'form-status'; }
  // A prior failed submit may have left "Retry" on the button — reset it.
  const btn = document.getElementById('reportSubmitBtn');
  if (btn) btn.textContent = 'Submit Report';

  document.getElementById('reportModalOverlay').classList.add('open');
}

function closeReportModal() {
  document.getElementById('reportModalOverlay').classList.remove('open');
}

async function handleReportSubmit(e) {
  e.preventDefault();
  const btn = document.getElementById('reportSubmitBtn');
  const statusEl = document.getElementById('reportFormStatus');
  const targetType = document.getElementById('report-target-type').value;
  const targetId = document.getElementById('report-target-id').value;
  const reason = document.getElementById('report-reason').value;
  const details = document.getElementById('report-details').value;

  // Guard the required fields client-side too: an empty select would otherwise
  // be sent and rejected by the server as a 400.
  if (!targetType || !targetId || !reason) {
    if (statusEl) { statusEl.textContent = '⚠️ Please choose a reason.'; statusEl.className = 'form-status error'; }
    return;
  }

  setBtnBusy(btn, true, 'Submitting…');
  if (statusEl) { statusEl.textContent = ''; statusEl.className = 'form-status'; }

  try {
    const res = await fetch(`${API_BASE}/reports`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetType, targetId, reason, details }),
    });
    const data = await res.json();
    if (!res.ok || !data.success) throw httpError(res, data);

    setBtnBusy(btn, false);
    showToast('✅ Report submitted. Thank you.');
    closeReportModal();
    document.getElementById('report-reason').value = '';
    document.getElementById('report-details').value = '';
    if (statusEl) { statusEl.textContent = ''; statusEl.className = 'form-status'; }
    if (btn) { btn.textContent = 'Submit Report'; btn.disabled = false; }
  } catch (err) {
    setBtnBusy(btn, false);
    if (btn) btn.textContent = 'Retry';
    if (statusEl) { statusEl.textContent = friendlyFetchError(err); statusEl.className = 'form-status error'; }
  }
}

// Delegated click dispatch for action buttons. Inline onclick attributes are
// blocked by the security CSP (Helmet's default script-src-attr 'none'), so
// every interactive element carries a data-action + data-* payload and is
// routed here — the same pattern the modal contact buttons already use (see
// setupModal). Capture phase means an action nested inside a .listing-card
// (store badge, owner edit/delete) can stopPropagation() before the card's own
// click handler opens the listing modal; those elements carry data-stop="1".
function setupActionDelegation() {
  document.addEventListener('click', (e) => {
    // Ported from main's setupDelegatedClicks: reload the grid after a
    // network failure (matched by class only — it carries no data-action).
    const retry = e.target.closest('.grid-retry-btn');
    if (retry) { loadListings(); return; }

    const el = e.target.closest('[data-action]');
    if (!el) return;
    if (el.dataset.stop) e.stopPropagation();

    switch (el.dataset.action) {
      // ── Listing / boost ──
      case 'close-modal': closeModal(); break;
      case 'edit-listing': editListing(el.dataset.listingId); break;
      case 'delete-listing': deleteListing(el.dataset.listingId); break;
      case 'select-boost': selectBoost(el); break;
      case 'select-package': selectPackage(el); break;
      case 'initiate-boost': initiateBoost(el.dataset.listingId); break;
      // ── Store ──
      case 'open-store-creation': openStoreCreationModal(); break;
      case 'open-store-page': openStorePage(el.dataset.slug); break;
      case 'edit-store': openStoreEditForm(el.dataset.storeId); break;
      case 'attach-listing': openAttachListingModal(el.dataset.storeId); break;
      case 'store-listings': openStoreListings(el.dataset.storeId); break;
      case 'delete-store': deleteStore(el.dataset.storeId); break;
      case 'select-store-plan': selectStorePlan(el); break;
      case 'close-store-modal': closeStoreModal(); break;
      // ── Reporting ──
      case 'report-listing': openReportModal('listing', el.dataset.targetId); break;
      case 'report-store': openReportModal('store', el.dataset.targetId); break;
      case 'close-report-modal': closeReportModal(); break;
      case 'save-store-edit': saveStoreEdit(el.dataset.storeId); break;
      case 'attach-listing-to-store': attachListingToStore(el.dataset.storeId, el.dataset.listingId); break;
      // ── Buyer contact acceptance gate ──
      case 'buyer-gate-cancel': _restoreBuyerGateListing(); break;
      case 'buyer-gate-continue': _handleBuyerGateContinue(); break;
    }
  }, true);

  // Escape closes the topmost dismissible modal. The store modal is
  // deliberately excluded: closing it aborts a pending payment poll, which an
  // accidental keypress must not do.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const reportOverlay = document.getElementById('reportModalOverlay');
    if (reportOverlay && reportOverlay.classList.contains('open')) {
      closeReportModal();
      return;
    }
    const listingOverlay = document.getElementById('modalOverlay');
    if (listingOverlay && listingOverlay.classList.contains('open')) {
      closeModal();
    }
  });
}

let _buyerGateSavedHTML = null;
let _buyerGateSavedTitle = '';
let _buyerGateSavedListingId = '';

function _restoreBuyerGateListing() {
  const card = document.getElementById('modalCard');
  if (_buyerGateSavedHTML) {
    card.innerHTML = _buyerGateSavedHTML;
    _buyerGateSavedHTML = null;
  }
}

// Build a wa.me link that always uses the international form. Kenyan numbers
// arrive as 07XXXXXXXX / 01XXXXXXXX, or already prefixed with 254.
function _waMeLink(rawNumber) {
  const digits = String(rawNumber || '').replace(/\D/g, '');
  const intl = digits.startsWith('254') ? digits : `254${digits.replace(/^0/, '')}`;
  return `https://wa.me/${intl}`;
}

function contactSeller(title, listingId) {
  const card = document.getElementById('modalCard');
  _buyerGateSavedHTML = card.innerHTML;
  _buyerGateSavedTitle = title;
  _buyerGateSavedListingId = listingId;

  card.innerHTML = `
    <button class="modal-close" data-action="buyer-gate-cancel">✕</button>
    <h3 style="font-family:var(--font-display); font-size:18px; margin:0 0 12px;">Contact Seller</h3>
    ${buyerContactAcceptanceHTML()}
    <div id="buyerGateActions" style="display:flex; gap:10px; margin-top:16px; flex-wrap:wrap;">
      <button type="button" class="btn btn-ghost" data-action="buyer-gate-cancel" style="flex:1;">Cancel</button>
      <button type="button" class="btn btn-primary" data-action="buyer-gate-continue" style="flex:1;">Continue &amp; Contact Seller</button>
    </div>
  `;
}

async function _handleBuyerGateContinue() {
  const title = _buyerGateSavedTitle;
  const listingId = _buyerGateSavedListingId;
  const continueBtn = document.querySelector('[data-action="buyer-gate-continue"]');
  if (continueBtn) { continueBtn.disabled = true; continueBtn.textContent = 'Checking…'; }

  let data;
  try {
    const res = await fetch(`${API_BASE}/terms/contact-acceptance`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        acceptance: buildBuyerAcceptanceToken(),
        listingId,
        listingTitle: title,
      }),
    });
    data = await res.json();
    if (!res.ok || !data.success) throw httpError(res, data);
  } catch (err) {
    showToast(friendlyFetchError(err));
    if (continueBtn) { continueBtn.disabled = false; continueBtn.textContent = 'Continue & Contact Seller'; }
    return;
  }

  // The server releases the seller number only after recording the acceptance.
  // Present it as a real link (never window.open) so the browser shows the
  // destination and the buyer opens WhatsApp deliberately.
  const actions = document.getElementById('buyerGateActions');
  if (actions && data.sellerWhatsapp) {
    const message = encodeURIComponent(`Hi! I saw your listing "${title}" on GikoMart. Is it still available?`);
    const href = escapeAttr(`${_waMeLink(data.sellerWhatsapp)}?text=${message}`);
    actions.innerHTML = `
      <p class="buyer-gate-ready" style="margin:0 0 8px; flex-basis:100%;">Seller contact ready</p>
      <a class="btn btn-primary" href="${href}" target="_blank" rel="noopener noreferrer" style="flex:1; text-align:center;">Open WhatsApp</a>
    `;
  }
}

function boostSectionHTML(listingId) {
  const optionsHTML = BOOST_OPTIONS.map((opt, i) => `
    <div class="boost-option ${i === 0 ? 'selected' : ''}" data-boost="${opt.id}" data-price="${opt.price}" data-action="select-boost">
      <div class="boost-option-info">
        <strong>${opt.label}</strong>
        <span>${opt.desc}</span>
      </div>
      <div class="boost-option-price">KSh ${opt.price}</div>
    </div>
  `).join('');

  return `
    <div class="boost-section">
      <div class="boost-label">⚡ Boost this listing</div>
      <div class="boost-options" id="boostOptions">${optionsHTML}</div>
      <input type="text" class="boost-phone-input" id="boostPhone" placeholder="M-Pesa number e.g. 0712345678">
      <button class="boost-pay-btn" id="boostPayBtn" data-action="initiate-boost" data-listing-id="${listingId}">Pay with M-Pesa</button>
      <div class="boost-status" id="boostStatus"></div>
    </div>
  `;
}

function selectBoost(el) {
  document.querySelectorAll('.boost-option').forEach(o => o.classList.remove('selected'));
  el.classList.add('selected');
}

function packageSectionHTML() {
  return `
    <div class="boost-section" style="margin-top:16px;">
      <div class="boost-label">💳 Choose a listing plan</div>
      <div class="boost-options" id="packageOptions">
        <div class="boost-option selected" data-package="quick" data-action="select-package">
          <div class="boost-option-info">
            <strong>Quick Sale (24h)</strong>
            <span>Food, tickets, urgent sales</span>
          </div>
          <div class="boost-option-price">KSh 30</div>
        </div>
        <div class="boost-option" data-package="standard" data-action="select-package">
          <div class="boost-option-info">
            <strong>Standard (7 days)</strong>
            <span>Most student-to-student sales</span>
          </div>
          <div class="boost-option-price">KSh 50</div>
        </div>
        <div class="boost-option" data-package="premium" data-action="select-package">
          <div class="boost-option-info">
            <strong>Premium (30 days)</strong>
            <span>Hostel rooms, electronics, long-term</span>
          </div>
          <div class="boost-option-price">KSh 150</div>
        </div>
      </div>
      <label style="display:block; margin-top:12px; font-size:14px; font-weight:600;">M-Pesa number to pay with</label>
      <input type="text" class="boost-phone-input" id="listingPhone" placeholder="e.g. 0712345678">
      <span style="font-size:12px; color:var(--ink-soft); display:block; margin-top:4px;">Can be different from your WhatsApp contact number above</span>
    </div>
  `;
}

function selectPackage(el) {
  document.querySelectorAll('#packageOptions .boost-option').forEach(o => o.classList.remove('selected'));
  el.classList.add('selected');
  updatePublishLabel();
}

function updatePublishLabel() {
  const btn = document.getElementById('submitBtn');
  if (!btn) return;
  const selected = document.querySelector('#packageOptions .boost-option.selected');
  const priceText = selected ? selected.querySelector('.boost-option-price') : null;
  const price = priceText ? priceText.textContent.replace(/[^0-9]/g, '') : '';
  const pkg = selected && selected.dataset.package ? selected.dataset.package : 'standard';
  const pkgPrices = { quick: 30, standard: 50, premium: 150 };
  const amt = price ? Number(price) : pkgPrices[pkg] || 50;
  btn.textContent = `Pay KSh ${amt.toLocaleString()} & Publish`;
}

async function initiateBoost(listingId) {
  const selected = document.querySelector('.boost-option.selected');
  const phone = document.getElementById('boostPhone').value.trim();
  const statusEl = document.getElementById('boostStatus');
  const btn = document.getElementById('boostPayBtn');

  if (!selected) {
    statusEl.textContent = 'Choose a boost option';
    statusEl.className = 'boost-status error';
    return;
  }
  if (!phone || phone.length < 9) {
    statusEl.textContent = 'Enter a valid M-Pesa number';
    statusEl.className = 'boost-status error';
    return;
  }

  const boostType = selected.dataset.boost;
  setBtnBusy(btn, true, 'Sending payment request…');
  statusEl.className = 'boost-status pending';

  try {
    const res = await fetch(`${API_BASE}/payments/boost`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Owner-Token': getOwnerToken(listingId) || '' },
      body: JSON.stringify({ listingId, phoneNumber: phone, boostType }),
    });

    const data = await res.json();
    if (!res.ok || !data.success) throw httpError(res, data);

    statusEl.textContent = '📲 Check your phone for the M-Pesa prompt to complete payment.';
    statusEl.className = 'boost-status success';
    btn.textContent = 'Request sent';
  } catch (err) {
    statusEl.textContent = friendlyFetchError(err);
    statusEl.className = 'boost-status error';
    setBtnBusy(btn, false);
  }
}

function setupForm() {
  const fields = ['f-title', 'f-category', 'f-price', 'f-description', 'f-location'];
  fields.forEach(id => {
    document.getElementById(id).addEventListener('input', updatePreview);
  });

  document.getElementById('packageSection').innerHTML = packageSectionHTML();
  setupImageUpload();
  document.getElementById('sellForm').addEventListener('submit', handleSubmit);

  // Inject seller acceptance notice just above the Publish submit button.
  const submitBtn = document.getElementById('submitBtn');
  if (submitBtn && !submitBtn.parentElement.querySelector('.terms-acceptance')) {
    const wrapper = document.createElement('div');
    wrapper.innerHTML = sellerListingAcceptanceHTML();
    const acceptanceEl = wrapper.firstElementChild;
    submitBtn.parentElement.insertBefore(acceptanceEl, submitBtn);
    submitBtn.style.marginTop = '12px';
    submitBtn.textContent = 'Pay & Publish';
  }
  updatePublishLabel();
  document.getElementById('packageOptions').addEventListener('click', (e) => {
    const opt = e.target.closest('.boost-option');
    if (opt) setTimeout(updatePublishLabel, 0);
  });

  updatePreview();
}

function setupImageUpload() {
  const box = document.getElementById('imageUploadBox');
  const input = document.getElementById('f-image');
  const placeholder = document.getElementById('imageUploadPlaceholder');
  const previewImg = document.getElementById('imagePreviewImg');
  const removeBtn = document.getElementById('imageRemoveBtn');
  const status = document.getElementById('imageUploadStatus');
  const submitBtn = document.getElementById('submitBtn');

  box.addEventListener('click', (e) => {
    if (e.target === removeBtn) return;
    if (!box.classList.contains('has-image')) input.click();
  });

  input.addEventListener('change', async () => {
    const file = input.files[0];
    if (!file) return;
    // Block a second pick while the current upload is still in flight.
    if (isUploading) return;

    if (file.size > 5 * 1024 * 1024) {
      status.textContent = 'File too large — max 5MB';
      status.className = 'image-upload-status error';
      return;
    }

    // Cloudinary upload can take several seconds on a slow connection. Show a
    // busy spinner over the drop-zone and disable the publish button so the
    // listing can't be submitted mid-upload or double-submitted before it ends.
    isUploading = true;
    box.classList.add('uploading');
    setBtnBusy(submitBtn, true);
    status.textContent = 'Uploading photo…';
    status.className = 'image-upload-status';

    const reader = new FileReader();
    reader.onload = (e) => {
      previewImg.src = e.target.result;
      previewImg.classList.add('show');
      placeholder.style.display = 'none';
      box.classList.add('has-image');
      removeBtn.hidden = false;

      const prevImg = document.getElementById('prev-image');
      prevImg.src = e.target.result;
      prevImg.hidden = false;
      prevImg.classList.add('show');
    };
    reader.readAsDataURL(file);

    try {
      const formData = new FormData();
      formData.append('image', file);

      const res = await fetchUploadWithRetry(formData, status);

      // Surface the server's actual rejection instead of a generic status. upload.js
      // answers 400/429 with { success:false, error }, and that message is the only
      // way a user learns e.g. that their image format isn't supported.
      // A 503 is the server signalling it is momentarily out of upload
      // capacity — an operational, retryable condition, not a bad file. Read
      // nothing from the body (it may be malformed) and keep the selected file
      // so the user can simply press Upload again.
      if (res.status === 503) {
        status.textContent = 'Server is busy — please try again in a moment';
        status.className = 'image-upload-status error';
        return;
      }

      if (!res.ok) {
        const bodyText = await res.text().catch(() => '');
        let serverError = '';
        try { serverError = (JSON.parse(bodyText) || {}).error || ''; } catch (_e) {}
        const err = new Error(serverError || `Upload failed (HTTP ${res.status})`);
        err.status = res.status;
        err.serverError = serverError;
        err.body = bodyText; // kept for the log — full response for context
        throw err;
      }
      const data = await res.json();

      uploadedImageUrl = data.url;
      status.textContent = '✅ Photo uploaded';
      status.className = 'image-upload-status success';
    } catch (err) {
      uploadedImageUrl = null;
      // err.status is set only when the request reached the server and it answered
      // non-2xx; without it the failure was client-side (network/CSP/CORS) and only
      // err.message is meaningful. Log the real evidence and surface the server's
      // own wording in the UI instead of a generic catchall.
      if (err && err.status) {
        console.warn(`Image upload failed: HTTP ${err.status} — ${err.body}`);
        status.textContent = err.serverError
          ? `⚠️ ${err.serverError} — listing will be posted without it`
          : `${friendlyFetchError(err)} — listing will be posted without it`;
      } else {
        console.warn('Image upload failed:', (err && err.message) || 'unknown error');
        status.textContent = `${friendlyFetchError(err)} — listing will be posted without it`;
      }
      status.className = 'image-upload-status error';
    } finally {
      isUploading = false;
      box.classList.remove('uploading');
      setBtnBusy(submitBtn, false);
    }
  });

  removeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    input.value = '';
    uploadedImageUrl = null;
    previewImg.src = '';
    previewImg.classList.remove('show');
    placeholder.style.display = 'flex';
    box.classList.remove('has-image');
    removeBtn.hidden = true;
    status.textContent = '';
    status.className = 'image-upload-status';

    const prevImg = document.getElementById('prev-image');
    prevImg.src = '';
    prevImg.hidden = true;
    prevImg.classList.remove('show');
  });
}

function resetImageUpload() {
  const box = document.getElementById('imageUploadBox');
  const input = document.getElementById('f-image');
  const placeholder = document.getElementById('imageUploadPlaceholder');
  const previewImg = document.getElementById('imagePreviewImg');
  const removeBtn = document.getElementById('imageRemoveBtn');
  const status = document.getElementById('imageUploadStatus');
  const prevImg = document.getElementById('prev-image');

  input.value = '';
  uploadedImageUrl = null;
  previewImg.src = '';
  previewImg.classList.remove('show');
  placeholder.style.display = 'flex';
  box.classList.remove('has-image');
  removeBtn.hidden = true;
  status.textContent = '';
  status.className = 'image-upload-status';
  prevImg.src = '';
  prevImg.hidden = true;
  prevImg.classList.remove('show');
}

function updatePreview() {
  const title = document.getElementById('f-title').value || 'Your item title';
  const category = document.getElementById('f-category').value || 'Category';
  const price = document.getElementById('f-price').value || '0';
  const desc = document.getElementById('f-description').value;
  const location = document.getElementById('f-location').value || 'Egerton University, Njoro';

  document.getElementById('prev-title').textContent = title;
  document.getElementById('prev-price').textContent = Number(price).toLocaleString();
  document.getElementById('prev-category').textContent = `📂 ${category}`;
  document.getElementById('prev-desc').textContent = desc
    ? `"${desc.slice(0, 80)}${desc.length > 80 ? '…' : ''}"`
    : '"Description preview…"';
  document.getElementById('prev-location').textContent = `📍 ${location}`;

  document.getElementById('mockTitle').textContent = title !== 'Your item title' ? title : 'Samsung Galaxy S22';
  document.getElementById('mockPrice').textContent = price !== '0' ? Number(price).toLocaleString() : '38,000';
}

async function handleSubmit(e) {
  e.preventDefault();

  const listingData = {
    title: document.getElementById('f-title').value.trim(),
    category: document.getElementById('f-category').value,
    condition: document.getElementById('f-condition').value,
    price: Number(document.getElementById('f-price').value),
    description: document.getElementById('f-description').value.trim(),
    sellerName: document.getElementById('f-seller').value.trim(),
    sellerWhatsapp: document.getElementById('f-whatsapp').value.trim(),
    location: document.getElementById('f-location').value.trim() || 'Egerton University, Njoro',
    images: uploadedImageUrl ? [uploadedImageUrl] : [],
  };

  const selectedPackage = document.querySelector('#packageOptions .boost-option.selected');
  const pkg = selectedPackage ? selectedPackage.dataset.package : 'standard';

  const listingPhoneInput = document.getElementById('listingPhone').value.trim();
  const paymentPhone = listingPhoneInput || listingData.sellerWhatsapp;

  const statusEl = document.getElementById('formStatus');
  const submitBtn = document.getElementById('submitBtn');

  if (!paymentPhone) {
    statusEl.textContent = '⚠️ Enter an M-Pesa number to pay with.';
    statusEl.className = 'form-status error';
    return;
  }

  // Guard against double-submission: while a payment is being confirmed the
  // button is already disabled, but this also covers a stray second submit.
  if (isPaymentInFlight || isUploading) return;

  statusEl.textContent = 'Sending payment request…';
  statusEl.className = 'form-status';
  isPaymentInFlight = true;
  setBtnBusy(submitBtn, true, 'Sending payment request…');

  try {
    const res = await fetch(`${API_BASE}/payments/initiate-listing`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        phoneNumber: paymentPhone,
        package: pkg,
        listingData,
        acceptance: buildSellerAcceptanceToken(),
        website: (document.getElementById('website') || {}).value || '',
      }),
    });

    const data = await res.json();
    if (!res.ok || !data.success) throw httpError(res, data);

    // Save the one-time owner token immediately, keyed by invoiceId (the only
    // id the client has at this point). Once the status poll reports the
    // created listing's id, the token is re-keyed to that listing.
    if (data.ownerToken && data.invoiceId) {
      try { localStorage.setItem(PENDING_TOKEN_PREFIX + data.invoiceId, data.ownerToken); } catch (err) { console.warn('Could not save owner token:', err); }
      pollListingStatus(data.invoiceId);
    }

    // Keep the button disabled through the whole M-Pesa confirmation window so
    // a second tap can't start a duplicate payment. pollListingStatus calls
    // endPaymentWait() when the webhook confirms — or times out/fails — to
    // re-enable it and report the outcome.
    setBtnBusy(submitBtn, true, 'Waiting for M-Pesa confirmation…');
    statusEl.textContent = `📲 Check your phone for the M-Pesa prompt (KSh ${data.amount}). Your listing will go live once payment is confirmed.`;
    statusEl.classList.add('success');
    showToast('📲 Payment request sent — check your phone');

    e.target.reset();
    document.getElementById('f-condition').value = 'Excellent';
    resetImageUpload();
    updatePreview();

  } catch (err) {
    console.error('Listing payment failed:', err.message);
    endPaymentWait(false, friendlyFetchError(err));
    showToast('⚠️ Payment request failed');
  }
}

// Terminal state for the M-Pesa initiate + poll flow: always re-enable the
// publish button (it stays disabled through the confirmation window) and
// report the outcome in the form's status line.
function endPaymentWait(ok, message) {
  isPaymentInFlight = false;
  setBtnBusy(document.getElementById('submitBtn'), false);
  const statusEl = document.getElementById('formStatus');
  if (!statusEl) return;
  statusEl.textContent = message || '';
  statusEl.className = `form-status ${ok ? 'success' : 'error'}`;
}

// ---- Owner edit/delete (token-gated) ---------------------------------------

async function editListing(id) {
  const token = getOwnerToken(id);
  if (!token) { showToast('⚠️ No owner token saved for this listing'); return; }
  const listing = allListings.find(l => l._id === id) || myListings.find(l => l._id === id);
  if (!listing) return;

  const newTitle = prompt('Edit title:', listing.title);
  if (newTitle === null) return;
  const newPriceRaw = prompt('Edit price (KSh):', listing.price);
  if (newPriceRaw === null) return;
  const newPrice = Number(newPriceRaw);
  if (!Number.isFinite(newPrice) || newPrice < 0) { showToast('⚠️ Invalid price'); return; }
  const newDescription = prompt('Edit description:', listing.description);
  if (newDescription === null) return;

  const updates = {};
  if (newTitle.trim() && newTitle.trim() !== listing.title) updates.title = newTitle.trim();
  if (newPrice !== listing.price) updates.price = newPrice;
  if (newDescription.trim() && newDescription.trim() !== listing.description) updates.description = newDescription.trim();
  if (!Object.keys(updates).length) { showToast('No changes made'); return; }

  // Disable this listing's edit/delete buttons (any instance — grid, dashboard
  // or open modal) with a spinner while the request runs. The buttons carry
  // data-listing-id, so target that attribute — the old data-listing selector
  // matched nothing, so the busy state never appeared.
  const btns = document.querySelectorAll(`.owner-btn[data-listing-id="${id}"]`);
  const editBtns = document.querySelectorAll(`.owner-btn.edit[data-listing-id="${id}"]`);
  btns.forEach(btn => setBtnBusy(btn, true));

  try {
    const res = await fetch(`${API_BASE}/listings/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Owner-Token': token },
      body: JSON.stringify(updates),
    });
    const data = await res.json();
    if (!res.ok || !data.success) throw httpError(res, data);

    const idx = allListings.findIndex(l => l._id === id);
    if (idx !== -1) allListings[idx] = { ...allListings[idx], ...data.listing, icon: CATEGORY_ICONS[data.listing.category] || allListings[idx].icon };
    renderListings();
    closeModal();
    showToast('✅ Listing updated');
    btns.forEach(btn => setBtnBusy(btn, false));
    // Brief confirmation on the (still-visible) edit button, then revert.
    editBtns.forEach(btn => { btn.textContent = 'Saved ✓'; });
    setTimeout(() => editBtns.forEach(btn => { btn.textContent = '✏️ Edit'; }), 2000);
  } catch (err) {
    console.error('Listing update failed:', err.message);
    showToast(friendlyFetchError(err));
    btns.forEach(btn => setBtnBusy(btn, false));
    // Inline retry: the delegated data-action handler re-runs editListing.
    editBtns.forEach(btn => { btn.textContent = 'Retry'; });
  }
}

async function deleteListing(id) {
  const token = getOwnerToken(id);
  if (!token) { showToast('⚠️ No owner token saved for this listing'); return; }
  const listing = allListings.find(l => l._id === id);
  if (!window.confirm(`Delete "${listing ? listing.title : 'this listing'}"? This cannot be undone.`)) return;

  // Disable this listing's edit/delete buttons while the request runs. Match
  // the actual data-listing-id attribute (see editListing for why).
  const btns = document.querySelectorAll(`.owner-btn[data-listing-id="${id}"]`);
  const deleteBtns = document.querySelectorAll(`.owner-btn.delete[data-listing-id="${id}"]`);
  btns.forEach(btn => setBtnBusy(btn, true));

  try {
    const res = await fetch(`${API_BASE}/listings/${id}`, {
      method: 'DELETE',
      headers: { 'X-Owner-Token': token },
    });
    const data = await res.json();
    if (!res.ok || !data.success) throw httpError(res, data);

    allListings = allListings.filter(l => l._id !== id);
    myListings = myListings.filter(l => l._id !== id);
    try { localStorage.removeItem(OWNER_TOKEN_PREFIX + id); } catch (err) {}
    document.getElementById('statListings').textContent = allListings.length;
    renderListings();
    closeModal();
    showToast('🗑️ Listing deleted');
    btns.forEach(btn => setBtnBusy(btn, false));
  } catch (err) {
    console.error('Listing delete failed:', err.message);
    showToast(friendlyFetchError(err));
    btns.forEach(btn => setBtnBusy(btn, false));
    // Inline retry: the delegated data-action handler re-runs deleteListing.
    deleteBtns.forEach(btn => { btn.textContent = 'Retry'; });
  }
}

function renderDashboard() {
  const grid = document.getElementById('myListingGrid');
  const total = myListings.length;
  const totalViews = myListings.reduce((sum, l) => sum + (l.views || 0), 0);
  const totalBroadcasts = myListings.filter(l => l.broadcastSent).length;

  document.getElementById('dashTotal').textContent = total;
  document.getElementById('dashViews').textContent = totalViews;
  document.getElementById('dashBroadcasts').textContent = totalBroadcasts;

  if (!total) {
    grid.innerHTML = `
      <div class="empty-state">
        <span class="empty-icon">🏷️</span>
        <p><strong>You haven't listed anything yet.</strong></p>
        <p>Head to the Sell tab to post your first item.</p>
      </div>`;
    return;
  }

  grid.innerHTML = myListings.map(l => listingCardHTML(l)).join('');
  grid.querySelectorAll('.listing-card').forEach(card => {
    card.addEventListener('click', () => openListingModal(card.dataset.id, myListings));
  });
}

function showToast(msg) {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 3000);
}

function escapeHTML(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// Escape a value for safe interpolation into a double-quoted HTML attribute.
// escapeHTML() is NOT sufficient here: the div.innerHTML trick leaves double
// quotes unencoded, which would allow attribute breakout. Entity-encoded
// attribute values are decoded back to their raw characters when read via
// element.dataset, so the delegated click listener receives the original text.
function escapeAttr(str) {
  if (str === undefined || str === null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function cloudinaryResize(url, transform) {
  if (!url || !url.includes('/upload/')) return url;
  return url.replace('/upload/', `/upload/${transform}/`);
}

// ════════════════════════════════════════════════════════════════════════════
// STORE FUNCTIONS
// ════════════════════════════════════════════════════════════════════════════

// ─── My Store view ──────────────────────────────────────────────────────────

async function renderMyStore() {
  const container = document.getElementById('mystoreContent');
  const myStoreIds = getAllMyStoreIds();

  if (myStoreIds.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <span class="empty-icon">🏪</span>
        <p><strong>You don't have a store yet.</strong></p>
        <p>Open a storefront on GikoMart to organize your listings and build your brand on campus.</p>
        <button class="btn btn-primary" data-action="open-store-creation" style="margin-top:16px;">Open a Store →</button>
      </div>`;
    return;
  }

  // Load the store (one-store-per-token enforced server-side)
  const storeId = myStoreIds[0];
  try {
    const res = await fetch(`${API_BASE}/stores/${storeId}`, {
      headers: { 'X-Store-Owner-Token': getStoreToken(storeId) }
    });
    const data = await res.json();
    if (!data.success) throw httpError(res, data);

    container.innerHTML = renderStoreManagementPanel(data.store, data.listingCount);
  } catch (err) {
    container.innerHTML = `<div class="empty-state"><span class="empty-icon">⚠️</span><p>${escapeHTML(friendlyFetchError(err))}</p>
      <button class="btn btn-primary" data-action="open-store-creation" style="margin-top:16px;">Open a Store →</button></div>`;
  }
}

function renderStoreManagementPanel(store, listingCount) {
  const isActive = store.status === 'active';
  const daysLeft = Math.max(0, Math.ceil((new Date(store.expires_at) - new Date()) / (1000 * 60 * 60 * 24)));
  const statusBadge = isActive
    ? '<span style="color:var(--success); font-weight:600;">● Active</span>'
    : `<span style="color:var(--danger); font-weight:600;">● ${store.status.charAt(0).toUpperCase() + store.status.slice(1)}</span>`;

  return `
    <div style="background:var(--card); border-radius:var(--radius-lg); padding:24px; margin-bottom:20px; box-shadow:var(--shadow-soft);">
      <div style="display:flex; align-items:center; gap:16px; margin-bottom:16px;">
        ${store.logo_url
          ? `<img src="${escapeAttr(cloudinaryResize(store.logo_url, 'w_80,h_80,c_fill,q_auto,f_auto'))}" style="width:80px; height:80px; border-radius:var(--radius-lg); object-fit:cover;">`
          : '<div style="width:80px; height:80px; border-radius:var(--radius-lg); background:var(--marigold-light); display:flex; align-items:center; justify-content:center; font-size:36px;">🏪</div>'}
        <div>
          <h3 style="margin:0; font-family:var(--font-display);">${escapeHTML(store.name)}</h3>
          <p style="margin:4px 0 0; color:var(--ink-soft); font-size:14px;">${escapeHTML(store.category)} · ${statusBadge}</p>
        </div>
      </div>

      <div class="dash-stats" style="margin-bottom:16px;">
        <div class="dash-stat">
          <span class="dash-num">${listingCount}</span>
          <span class="dash-label">listings in store</span>
        </div>
        <div class="dash-stat">
          <span class="dash-num">${store.listing_limit}</span>
          <span class="dash-label">max listings (${store.plan.replace(/_/g, ' ')})</span>
        </div>
        <div class="dash-stat">
          <span class="dash-num">${daysLeft}</span>
          <span class="dash-label">days until expiry</span>
        </div>
      </div>

      <div style="display:flex; gap:8px; flex-wrap:wrap;">
        <button class="btn btn-ghost" data-action="edit-store" data-store-id="${store._id}">✏️ Edit Store</button>
        <button class="btn btn-ghost" data-action="attach-listing" data-store-id="${store._id}">🔗 Attach Listing</button>
        <button class="btn btn-ghost" data-action="store-listings" data-store-id="${store._id}">📋 Store Listings</button>
        <button class="btn btn-ghost" data-action="open-store-page" data-slug="${escapeAttr(store.slug)}">🌐 Public Page</button>
        <button class="btn btn-ghost" style="color:var(--danger);" data-action="delete-store" data-store-id="${store._id}">🗑️ Delete Store</button>
      </div>
    </div>

    <div id="storeListingsSection"></div>
  `;
}

// ─── Store creation modal ───────────────────────────────────────────────────

function openStoreCreationModal() {
  const card = document.getElementById('storeModalCard');
  const categoriesHTML = STORE_CATEGORIES.map(c =>
    `<option value="${c.name}">${c.icon} ${c.name}</option>`
  ).join('');
  const plansHTML = STORE_PLANS.map((p, i) => `
    <div class="boost-option ${i === 0 ? 'selected' : ''}" data-plan="${p.id}" data-action="select-store-plan">
      <div class="boost-option-info">
        <strong>${p.label}</strong>
        <span>${p.duration} · up to ${p.maxListings} listings</span>
      </div>
      <div class="boost-option-price">KSh ${p.price}</div>
    </div>
  `).join('');

  card.innerHTML = `
    <button class="modal-close" data-action="close-store-modal">✕</button>
    <h3 style="font-family:var(--font-display); margin:0 0 16px;">Open a Store</h3>
    <form id="storeCreationForm">
      <div class="field-group">
        <label>Store name</label>
        <input type="text" id="sc-name" placeholder="e.g. Teryl's Tech Shop" required>
      </div>
      <div class="field-group">
        <label>Store category</label>
        <select id="sc-category" required>${categoriesHTML}</select>
      </div>
      <div class="field-group">
        <label>Description</label>
        <textarea id="sc-description" placeholder="What does your store sell?" rows="3"></textarea>
      </div>
      <div class="field-row">
        <div class="field-group">
          <label>Contact phone</label>
          <input type="text" id="sc-phone" placeholder="0712345678" required>
        </div>
        <div class="field-group">
          <label>WhatsApp number</label>
          <input type="text" id="sc-whatsapp" placeholder="0712345678" required>
        </div>
      </div>
      <div class="field-group">
        <label>Email (optional)</label>
        <input type="email" id="sc-email" placeholder="you@email.com">
      </div>
      <div class="field-group">
        <label>Location / campus area</label>
        <input type="text" id="sc-location" placeholder="e.g. Njoro, near Main Gate">
      </div>

      <div class="boost-section" style="margin-top:16px;">
        <div class="boost-label">💳 Choose a store plan</div>
        <div class="boost-options" id="storePlanOptions">${plansHTML}</div>
      </div>

      <div class="field-group" style="margin-top:12px;">
        <label>M-Pesa number to pay with</label>
        <input type="text" id="sc-phoneNumber" placeholder="e.g. 0712345678" required>
      </div>

      ${storeCreationAcceptanceHTML()}

      <button type="submit" class="btn btn-primary btn-block" id="storeSubmitBtn" style="margin-top:12px;">Pay & Open Store</button>
      <div class="form-status" id="storeFormStatus"></div>
    </form>
  `;
  document.getElementById('storeModalOverlay').classList.add('open');
}

function selectStorePlan(el) {
  document.querySelectorAll('#storePlanOptions .boost-option').forEach(o => o.classList.remove('selected'));
  el.classList.add('selected');
}

function closeStoreModal() {
  document.getElementById('storeModalOverlay').classList.remove('open');
  // The modal hosts the store-payment flow; abort its pending poll so a closed
  // modal cannot keep scheduling background timers.
  clearStorePoll();
}

async function handleStorePlanSubmit(e) {
  e.preventDefault();
  const selectedPlan = document.querySelector('#storePlanOptions .boost-option.selected');
  if (!selectedPlan) { showToast('⚠️ Select a store plan'); return; }

  const storeData = {
    name: document.getElementById('sc-name').value.trim(),
    category: document.getElementById('sc-category').value,
    description: document.getElementById('sc-description').value.trim(),
    phone: document.getElementById('sc-phone').value.trim(),
    whatsapp: document.getElementById('sc-whatsapp').value.trim(),
    email: document.getElementById('sc-email').value.trim(),
    location: document.getElementById('sc-location').value.trim(),
  };

  const phoneNumber = document.getElementById('sc-phoneNumber').value.trim();
  const storePlan = selectedPlan.dataset.plan;
  const statusEl = document.getElementById('storeFormStatus');
  const btn = document.getElementById('storeSubmitBtn');

  if (!phoneNumber || phoneNumber.length < 9) {
    statusEl.textContent = '⚠️ Enter a valid M-Pesa number';
    statusEl.className = 'form-status error';
    return;
  }

  // The modal's terms notice is baked when the modal opens, so a version bump
  // (or a slow first /terms/versions fetch) could transmit stale or blank
  // versions. Re-fetch and re-render at submit time so the displayed and
  // transmitted versions always match what the server enforces right now.
  await loadTermsVersions();
  const termsNotice = document.querySelector('#storeCreationForm .terms-acceptance[data-terms-type="store-creation"]');
  if (termsNotice) termsNotice.outerHTML = storeCreationAcceptanceHTML();

  setBtnBusy(btn, true, 'Sending payment request…');
  statusEl.className = 'form-status';

  try {
    const res = await fetch(`${API_BASE}/payments/initiate-store-plan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phoneNumber, storePlan, storeData, acceptance: buildStoreAcceptanceToken() }),
    });
    const data = await res.json();
    if (!res.ok || !data.success) throw httpError(res, data);

    // Save pending store token
    if (data.ownerToken && data.invoiceId) {
      try { localStorage.setItem(PENDING_TOKEN_PREFIX + data.invoiceId, data.ownerToken); } catch (err) {}
      pollStoreStatus(data.invoiceId);
    }

    statusEl.textContent = `📲 Check your phone (KSh ${data.amount}). Your store opens once payment is confirmed.`;
    statusEl.className = 'form-status success';
    showToast('📲 Store payment request sent');
    btn.textContent = 'Request sent';
  } catch (err) {
    statusEl.textContent = friendlyFetchError(err);
    statusEl.className = 'form-status error';
    setBtnBusy(btn, false);
  }
}

function pollStoreStatus(invoiceId, attempt = 0) {
  if (attempt >= STATUS_POLL_MAX_ATTEMPTS) {
    // Same Recovery hand-off as the listing poller: release the submit button
    // and offer a single manual status check instead of a vanishing toast.
    const btn = document.getElementById('storeSubmitBtn');
    if (btn) { btn.disabled = false; btn.textContent = 'Pay & Open Store'; }
    showPaymentRecovery(document.getElementById('storeFormStatus'), invoiceId, () => checkStoreStatusManually(invoiceId));
    return;
  }
  fetch(`${API_BASE}/payments/status/${encodeURIComponent(invoiceId)}`)
    .then(res => (res.ok ? res.json() : null))
    .then(data => {
      if (data && data.success && data.storeId) {
        // Adopt the pending token onto the store id
        let token = null;
        try { token = localStorage.getItem(PENDING_TOKEN_PREFIX + invoiceId); } catch (err) {}
        if (token) {
          saveStoreToken(data.storeId, token);
          try { localStorage.removeItem(PENDING_TOKEN_PREFIX + invoiceId); } catch (err) {}
        }
        closeStoreModal();
        showToast('✅ Store created!');
        renderMyStore();
        return;
      }
      if (data && data.success && data.status === 'failed') {
        try { localStorage.removeItem(PENDING_TOKEN_PREFIX + invoiceId); } catch (err) {}
        showToast('❌ Store payment failed');
        return;
      }
      storePollTimer = setTimeout(() => pollStoreStatus(invoiceId, attempt + 1), pollBackoffDelay(attempt));
    })
    .catch(() => {
      storePollTimer = setTimeout(() => pollStoreStatus(invoiceId, attempt + 1), pollBackoffDelay(attempt));
    });
}

// ─── Store management ───────────────────────────────────────────────────────

// Manual status check for a store-plan payment in Recovery (store modal).
async function checkStoreStatusManually(invoiceId) {
  const statusEl = document.getElementById('storeFormStatus');
  let data;
  try {
    const res = await fetch(`${API_BASE}/payments/status/${encodeURIComponent(invoiceId)}`);
    if (!res.ok) throw httpError(res, null);
    data = await res.json();
  } catch (err) {
    if (statusEl) {
      statusEl.className = 'form-status error';
      statusEl.textContent = friendlyFetchError(err);
    }
    return;
  }

  if (data && data.success && data.storeId) {
    let token = null;
    try { token = localStorage.getItem(PENDING_TOKEN_PREFIX + invoiceId); } catch (err) {}
    if (token) {
      saveStoreToken(data.storeId, token);
      try { localStorage.removeItem(PENDING_TOKEN_PREFIX + invoiceId); } catch (err) {}
    }
    closeStoreModal();
    showToast('✅ Store created!');
    renderMyStore();
    return;
  }
  if (data && data.success && data.status === 'failed') {
    try { localStorage.removeItem(PENDING_TOKEN_PREFIX + invoiceId); } catch (err) {}
    showToast('❌ Store payment failed');
    if (statusEl) {
      statusEl.className = 'form-status error';
      statusEl.textContent = '❌ Store payment failed. Please try again.';
    }
    return;
  }
  if (statusEl) {
    statusEl.className = 'form-status error';
    statusEl.textContent = `Still processing. Please contact support with reference: ${invoiceId}.`;
  }
}

async function openStoreEditForm(storeId) {
  const token = getStoreToken(storeId);
  if (!token) { showToast('⚠️ No store token'); return; }

  try {
    const res = await fetch(`${API_BASE}/stores/${storeId}`, {
      headers: { 'X-Store-Owner-Token': token }
    });
    const data = await res.json();
    if (!data.success) throw httpError(res, data);
    const store = data.store;

    const card = document.getElementById('storeModalCard');
    card.innerHTML = `
      <button class="modal-close" data-action="close-store-modal">✕</button>
      <h3 style="font-family:var(--font-display); margin:0 0 16px;">Edit Store</h3>
      <div class="field-group">
        <label>Store name</label>
        <input type="text" id="se-name" value="${escapeAttr(store.name)}">
      </div>
      <div class="field-group">
        <label>Description</label>
        <textarea id="se-description" rows="3">${escapeHTML(store.description)}</textarea>
      </div>
      <div class="field-row">
        <div class="field-group">
          <label>Phone</label>
          <input type="text" id="se-phone" value="${escapeAttr(store.phone)}">
        </div>
        <div class="field-group">
          <label>WhatsApp</label>
          <input type="text" id="se-whatsapp" value="${escapeAttr(store.whatsapp)}">
        </div>
      </div>
      <div class="field-group">
        <label>Location</label>
        <input type="text" id="se-location" value="${escapeAttr(store.location)}">
      </div>
      <button class="btn btn-primary btn-block" data-action="save-store-edit" data-store-id="${storeId}" style="margin-top:12px;">Save Changes</button>
    `;
    document.getElementById('storeModalOverlay').classList.add('open');
  } catch (err) {
    showToast(friendlyFetchError(err));
  }
}

async function saveStoreEdit(storeId) {
  const token = getStoreToken(storeId);
  const saveBtn = document.querySelector('[data-action="save-store-edit"]');
  const updates = {
    name: document.getElementById('se-name').value.trim(),
    description: document.getElementById('se-description').value.trim(),
    phone: document.getElementById('se-phone').value.trim(),
    whatsapp: document.getElementById('se-whatsapp').value.trim(),
    location: document.getElementById('se-location').value.trim(),
  };

  setBtnBusy(saveBtn, true, 'Saving…');
  try {
    const res = await fetch(`${API_BASE}/stores/${storeId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Store-Owner-Token': token },
      body: JSON.stringify(updates),
    });
    const data = await res.json();
    if (!res.ok || !data.success) throw httpError(res, data);
    setBtnBusy(saveBtn, false);
    if (saveBtn) saveBtn.textContent = 'Saved ✓';
    showToast('✅ Store updated');
    renderMyStore();
    // Keep the confirmation visible briefly, then revert the label and close.
    setTimeout(() => {
      if (saveBtn) saveBtn.textContent = 'Save Changes';
      closeStoreModal();
    }, 2000);
  } catch (err) {
    // Keep the modal open with the form data intact; the delegated
    // data-action handler re-runs the save when the user clicks Retry.
    setBtnBusy(saveBtn, false);
    if (saveBtn) saveBtn.textContent = 'Retry';
    showToast(friendlyFetchError(err));
  }
}

async function deleteStore(storeId) {
  if (!window.confirm('Delete this store and ALL its listings? This cannot be undone.')) return;
  const token = getStoreToken(storeId);
  try {
    const res = await fetch(`${API_BASE}/stores/${storeId}`, {
      method: 'DELETE',
      headers: { 'X-Store-Owner-Token': token },
    });
    const data = await res.json();
    if (!res.ok || !data.success) throw httpError(res, data);
    try { localStorage.removeItem(STORE_OWNER_TOKEN_PREFIX + storeId); } catch (err) {}
    showToast('🗑️ Store deleted');
    renderMyStore();
    loadListings(); // refresh browse to remove deleted listings
  } catch (err) {
    showToast(friendlyFetchError(err));
  }
}

// ─── Attach / Detach listings ───────────────────────────────────────────────

async function openAttachListingModal(storeId) {
  // Find standalone listings (owned by this browser, not in any store)
  const owned = myListings.filter(l => !l.store_name);
  if (!owned.length) {
    showToast('No standalone listings to attach — create one first');
    return;
  }

  const card = document.getElementById('storeModalCard');
  const listHTML = owned.map(l => `
    <div class="boost-option" data-action="attach-listing-to-store" data-store-id="${storeId}" data-listing-id="${l._id}" style="cursor:pointer;">
      <div class="boost-option-info">
        <strong>${escapeHTML(l.title)}</strong>
        <span>KSh ${Number(l.price).toLocaleString()} · ${escapeHTML(l.category)}</span>
      </div>
    </div>
  `).join('');

  card.innerHTML = `
    <button class="modal-close" data-action="close-store-modal">✕</button>
    <h3 style="font-family:var(--font-display); margin:0 0 16px;">Attach a Listing</h3>
    <p style="color:var(--ink-soft); margin-bottom:12px;">Select a listing to add to your store:</p>
    ${listHTML}
  `;
  document.getElementById('storeModalOverlay').classList.add('open');
}

async function attachListingToStore(storeId, listingId) {
  const storeToken = getStoreToken(storeId);
  const listingToken = getOwnerToken(listingId);
  try {
    const res = await fetch(`${API_BASE}/stores/${storeId}/attach-listing`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'X-Store-Owner-Token': storeToken,
        'X-Owner-Token': listingToken,
      },
      body: JSON.stringify({ listingId }),
    });
    const data = await res.json();
    if (!res.ok || !data.success) throw httpError(res, data);
    closeStoreModal();
    showToast('✅ Listing attached to store');
    loadListings();
    renderMyStore();
  } catch (err) {
    showToast(friendlyFetchError(err));
  }
}

async function openStoreListings(storeId) {
  const section = document.getElementById('storeListingsSection');
  if (!section) return;
  section.innerHTML = '<div class="listing-grid" id="storeListingsGrid"></div>';
  const grid = document.getElementById('storeListingsGrid');
  showGridSkeleton(grid, 4);

  try {
    const res = await fetch(`${API_BASE}/listings?store_id=${storeId}`);
    const data = await res.json();
    if (!data.success) throw httpError(res, data);

    if (!data.listings.length) {
      section.innerHTML = '<div class="empty-state"><p>No listings in this store yet.</p></div>';
      return;
    }

    section.innerHTML = `<h3 style="font-family:var(--font-display); margin-bottom:12px;">Store Listings (${data.listings.length})</h3>
      <div class="listing-grid">${data.listings.map(l => listingCardHTML(l)).join('')}</div>`;
    section.querySelectorAll('.listing-card').forEach(card => {
      card.addEventListener('click', () => openListingModal(card.dataset.id, data.listings));
    });
  } catch (err) {
    section.innerHTML = `<div class="empty-state"><p>${escapeHTML(friendlyFetchError(err))}</p></div>`;
  }
}

// ─── Public store page ──────────────────────────────────────────────────────

async function openStorePage(slug) {
  switchView('storepage');
  const container = document.getElementById('storePageContent');
  // Skeleton cards, not a text placeholder, while the store + its listings
  // load — matches the browse grid's loading affordance.
  container.innerHTML = '<div class="listing-grid" id="storePageListings"></div>';
  showGridSkeleton(document.getElementById('storePageListings'), 4);

  try {
    const res = await fetch(`${API_BASE}/stores/slug/${encodeURIComponent(slug)}`);
    const data = await res.json();
    if (!data.success) throw httpError(res, data);

    const store = data.store;
    container.innerHTML = `
      <div style="background:var(--card); border-radius:var(--radius-lg); overflow:hidden; box-shadow:var(--shadow-soft); margin-bottom:24px;">
        ${store.cover_url
          ? `<div style="height:200px; background:url('${escapeAttr(cloudinaryResize(store.cover_url, 'w_1200,h_400,c_fill,q_auto,f_auto'))}') center/cover;"></div>`
          : '<div style="height:120px; background:linear-gradient(135deg, var(--marigold), var(--teal));"></div>'}
        <div style="padding:24px;">
          <div style="display:flex; align-items:center; gap:16px; margin-bottom:16px;">
            ${store.logo_url
              ? `<img src="${escapeAttr(cloudinaryResize(store.logo_url, 'w_80,h_80,c_fill,q_auto,f_auto'))}" style="width:80px; height:80px; border-radius:var(--radius-lg); object-fit:cover; border:3px solid var(--card);">`
              : '<div style="width:80px; height:80px; border-radius:var(--radius-lg); background:var(--marigold-light); display:flex; align-items:center; justify-content:center; font-size:36px; border:3px solid var(--card);">🏪</div>'}
            <div>
              <h2 style="margin:0; font-family:var(--font-display);">${escapeHTML(store.name)}</h2>
              <p style="margin:4px 0 0; color:var(--ink-soft);">${escapeHTML(store.category)}${store.verification_status === 'verified' ? ' · ✅ Verified' : ''}</p>
            </div>
          </div>
          ${store.description ? `<p style="color:var(--ink-soft); margin-bottom:16px;">${escapeHTML(store.description)}</p>` : ''}
          <div style="display:flex; gap:16px; flex-wrap:wrap; font-size:14px; color:var(--ink-soft);">
            ${store.location ? `<span>📍 ${escapeHTML(store.location)}</span>` : ''}
            ${store.opening_hours ? `<span>🕐 ${escapeHTML(store.opening_hours)}–${escapeHTML(store.closing_hours)}</span>` : ''}
            ${store.open_days ? `<span>📅 ${escapeHTML(store.open_days)}</span>` : ''}
            ${store.delivery_available ? '<span>🚚 Delivery</span>' : ''}
            ${store.pickup_available ? '<span>📦 Pickup</span>' : ''}
            ${store.whatsapp ? `<span>💬 WhatsApp</span>` : ''}
          </div>
          <button class="btn btn-ghost btn-sm" data-action="report-store" data-target-id="${escapeAttr(store._id)}" style="margin-top:16px;">🚩 Report this store</button>
        </div>
      </div>
      <h3 style="font-family:var(--font-display); margin-bottom:12px;">Listings (${data.listingCount})</h3>
      <div class="listing-grid" id="storePageListings"></div>
    `;

    // Load store listings: keep skeletons in the grid until they arrive.
    const grid = document.getElementById('storePageListings');
    showGridSkeleton(grid, 4);
    const listRes = await fetch(`${API_BASE}/listings?store_id=${store._id}`);
    const listData = await listRes.json();
    grid.removeAttribute('aria-busy');
    if (listData.success && listData.listings.length) {
      grid.innerHTML = listData.listings.map(l => listingCardHTML(l)).join('');
      grid.querySelectorAll('.listing-card').forEach(card => {
        card.addEventListener('click', () => openListingModal(card.dataset.id, listData.listings));
      });
    } else {
      grid.innerHTML = '<div class="empty-state"><p>No active listings in this store.</p></div>';
    }
  } catch (err) {
    container.innerHTML = `<div class="empty-state"><span class="empty-icon">🔍</span><p>${escapeHTML(friendlyFetchError(err))}</p></div>`;
  }
}