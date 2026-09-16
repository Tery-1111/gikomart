/* ============================================
   GikoMart Frontend — app.js
   Connects to the Express + MongoDB backend
   ============================================ */

// Same-origin in production (gikomart.onrender.com) and locally: the Express
// server that serves the UI also mounts /api, so deriving the base from the
// page's own origin works in both — and avoids connect-src/CORS violations
// from a hardcoded localhost:5000 when the dev server runs on another port.
const API_BASE = `${window.location.origin}/api`;

// Ownership tokens: after a listing payment completes, the server hands back a
// one-time owner token. It is stored only in this browser (localStorage) and
// sent back as X-Owner-Token on edit/delete. Before the listing's id is known,
// the token waits keyed by the payment's invoiceId ("pending"), then is
// re-keyed to the listing id once the status poll reveals it.
const OWNER_TOKEN_PREFIX = 'gikomart_ownerToken:';
const PENDING_TOKEN_PREFIX = 'gikomart_pendingToken:';
const STATUS_POLL_INTERVAL_MS = 3000;
const STATUS_POLL_MAX_ATTEMPTS = 100; // ~5 minutes

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

let allListings = [];
let myListings = [];
let activeCategory = '';
let usingDemoData = false;
let uploadedImageUrl = null;
let browseFetchFailed = false;   // last /listings fetch failed → show retry banner
let gridRequestId = 0;           // increments per fetch; stale responses are dropped
let isUploading = false;         // a Cloudinary upload is in flight
let isPaymentInFlight = false;   // an M-Pesa initiate/poll is in progress

document.addEventListener('DOMContentLoaded', () => {
  buildCategoryPills();
  buildCategorySelect();
  buildPulseTicker();
  setupNav();
  setupForm();
  setupModal();
  setupDelegatedClicks();
  loadListings();
  recoverPendingTokens();
});

function setupNav() {
  document.querySelectorAll('[data-view]').forEach(el => {
    el.addEventListener('click', () => switchView(el.dataset.view));
  });
}

// One document-level click delegation for the small interactive controls that
// would otherwise need an inline onclick attribute — which the hardened CSP
// blocks (inline scripts aren't allowed without 'unsafe-inline'). Each handler
// only fires when the click lands on (or inside) the matching element, and the
// values it passes come from data-attributes written with escapeAttr/escaped
// template output, never from raw JS string interpolation.
function setupDelegatedClicks() {
  document.addEventListener('click', (e) => {
    const retry = e.target.closest('.grid-retry-btn');
    if (retry) { loadListings(); return; }

    const close = e.target.closest('.modal-close');
    if (close) { closeModal(); return; }

    const boostOpt = e.target.closest('.boost-option[data-boost]');
    if (boostOpt) { selectBoost(boostOpt); return; }

    const pkgOpt = e.target.closest('.boost-option[data-package]');
    if (pkgOpt) { selectPackage(pkgOpt); return; }

    const payBtn = e.target.closest('.boost-pay-btn');
    if (payBtn) { initiateBoost(payBtn.dataset.listing); return; }
  });
}

// Owner edit/delete buttons sit inside a listing card whose own click handler
// opens the modal — so the button's own listener stops propagation first, then
// dispatches to the right owner action. Values travel via data-listing
// (never inline JS strings) for the same CSP + stored-XSS reasons as above.
function attachOwnerButtons(container) {
  container.querySelectorAll('.owner-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = btn.dataset.listing;
      if (!id) return;
      if (btn.classList.contains('edit')) editListing(id);
      else deleteListing(id);
    });
  });
}

function switchView(view) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.querySelectorAll('.nav-link').forEach(n => n.classList.remove('active'));
  document.getElementById('view-' + view).classList.add('active');
  document.querySelectorAll(`.nav-link[data-view="${view}"]`).forEach(n => n.classList.add('active'));

  if (view === 'dashboard') renderDashboard();
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
    showToast('⏳ Still waiting for payment confirmation — your listing will appear after a refresh');
    // Don't leave the publish button disabled forever: release it so the user
    // can retry, and say why.
    if (isPaymentInFlight) endPaymentWait(false, '⏳ M-Pesa confirmation is taking longer than expected. Check your phone, then try again.');
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
      setTimeout(() => pollListingStatus(invoiceId, attempt + 1), STATUS_POLL_INTERVAL_MS);
    })
    .catch(() => setTimeout(() => pollListingStatus(invoiceId, attempt + 1), STATUS_POLL_INTERVAL_MS));
}

// One-time recovery for tokens left pending by a closed tab (e.g. the user
// navigated away before the payment webhook landed).
function recoverPendingTokens() {
  let pendingInvoiceIds = [];
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
    if (!res.ok) throw new Error('API not reachable');
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
  }
  myListings = allListings.filter(l => hasOwnerToken(l._id));
  document.getElementById('statListings').textContent = allListings.length;
  renderListings();
}

// Render a row of shimmer skeleton cards matching the real card layout
// (image block, title line, price line, meta line) so nothing shifts when
// the actual listings load in. Used for the initial fetch and any re-fetch.
function showGridSkeleton(grid) {
  const placeholders = Array.from({ length: 8 }, () => `
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
      ? `<div class="grid-error"><span>⚠️ Couldn't reach the server — showing sample listings.</span><button type="button" class="grid-retry-btn">↻ Retry</button></div>`
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
    ? `<div class="grid-error"><span>⚠️ Couldn't reach the server — showing sample listings.</span><button type="button" class="grid-retry-btn">↻ Retry</button></div>`
    : '';

  grid.innerHTML = errorBanner + filtered.map(l => listingCardHTML(l)).join('');

  grid.querySelectorAll('.listing-card').forEach(card => {
    card.addEventListener('click', () => openListingModal(card.dataset.id, filtered));
  });
  attachOwnerButtons(grid);
}

function listingCardHTML(l) {
  const condClass = 'cond-' + l.condition.replace(/\s+/g, '-');
  const hasImage = l.images && l.images.length > 0;
  const imageContent = hasImage
    ? `<img src="${cloudinaryResize(l.images[0], 'w_400,h_400,c_fill,q_auto,f_auto')}" alt="${escapeHTML(l.title)}" loading="lazy">`
    : l.icon;
  const badgeHTML = l.featured
    ? `<span class="featured-badge ${l.boostType === 'rush' ? 'rush-badge' : ''}">⭐ ${l.boostType === 'rush' ? 'Rush Boost' : 'Featured'}</span>`
    : '';
  // Only listings this browser holds an owner token for get edit/delete controls.
  const owned = !usingDemoData && hasOwnerToken(l._id);
  const ownerControlsHTML = owned ? `
        <div class="owner-controls">
          <button class="owner-btn edit" data-listing="${l._id}">✏️ Edit</button>
          <button class="owner-btn delete" data-listing="${l._id}">🗑️ Delete</button>
        </div>` : '';
  return `
    <div class="listing-card" data-id="${l._id}">
      <div class="listing-image">
        ${imageContent}
        ${badgeHTML}
        <span class="condition-badge ${condClass}">${l.condition}</span>
      </div>
      <div class="listing-body">
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
    contactSeller(btn.dataset.whatsapp || '', btn.dataset.title || '');
  });
}

function openListingModal(id, source) {
  const listing = (source || allListings).find(l => l._id === id);
  if (!listing) return;

  const condClass = 'cond-' + listing.condition.replace(/\s+/g, '-');
  const hasImage = listing.images && listing.images.length > 0;
  const modalImageContent = hasImage
    ? `<img src="${cloudinaryResize(listing.images[0], 'w_800,q_auto,f_auto')}" alt="${escapeHTML(listing.title)}" style="width:100%;height:100%;object-fit:cover;">`
    : (listing.icon || CATEGORY_ICONS[listing.category] || '📦');
  const card = document.getElementById('modalCard');
  card.innerHTML = `
    <button class="modal-close">✕</button>
    <div class="modal-image">${modalImageContent}</div>
    <span class="condition-badge ${condClass}">${listing.condition}</span>
    <h3 style="font-family:var(--font-display); font-size:20px; margin:10px 0 4px;">${escapeHTML(listing.title)}</h3>
    <div class="modal-price">KSh ${Number(listing.price).toLocaleString()}</div>
    <div class="modal-meta-row">
      <span>📂 ${escapeHTML(listing.category)}</span>
      <span>📍 ${escapeHTML(listing.location || 'Egerton')}</span>
      <span>👤 ${escapeHTML(listing.sellerName)}</span>
      <span>👁️ ${listing.views || 0} views</span>
    </div>
    <p class="modal-desc">${escapeHTML(listing.description)}</p>
    <button class="contact-btn" data-whatsapp="${escapeAttr(listing.sellerWhatsapp)}" data-title="${escapeAttr(listing.title)}">
      💬 Contact seller on WhatsApp
    </button>
    ${!usingDemoData && hasOwnerToken(listing._id) ? `
    <div class="owner-controls">
      <button class="owner-btn edit" data-listing="${listing._id}">✏️ Edit listing</button>
      <button class="owner-btn delete" data-listing="${listing._id}">🗑️ Delete listing</button>
    </div>` : ''}
    ${listing.featured ? '' : boostSectionHTML(listing._id)}
  `;
  document.getElementById('modalOverlay').classList.add('open');

  if (!usingDemoData && !id.startsWith('demo')) {
    // List responses intentionally omit sellerWhatsapp (anti-scraping); the
    // per-listing detail endpoint is the only source of the contact number.
    // Fetch it and backfill the contact button once it arrives.
    fetch(`${API_BASE}/listings/${id}`)
      .then(res => (res.ok ? res.json() : null))
      .then(data => {
        if (data && data.success && data.listing && data.listing.sellerWhatsapp) {
          const btn = card.querySelector('.contact-btn');
          if (btn) btn.dataset.whatsapp = data.listing.sellerWhatsapp;
        }
      })
      .catch(() => {});
  }
}

function closeModal() {
  document.getElementById('modalOverlay').classList.remove('open');
}

function contactSeller(whatsapp, title) {
  if (!whatsapp) { showToast('⏳ Loading contact details…'); return; }
  const cleanNumber = whatsapp.replace(/[\s+]/g, '');
  const message = encodeURIComponent(`Hi! I saw your listing "${title}" on GikoMart. Is it still available?`);
  window.open(`https://wa.me/${cleanNumber}?text=${message}`, '_blank');
}

function boostSectionHTML(listingId) {
  const optionsHTML = BOOST_OPTIONS.map((opt, i) => `
    <div class="boost-option ${i === 0 ? 'selected' : ''}" data-boost="${opt.id}" data-price="${opt.price}">
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
      <button class="boost-pay-btn" id="boostPayBtn" data-listing="${listingId}">Pay with M-Pesa</button>
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
        <div class="boost-option selected" data-package="quick">
          <div class="boost-option-info">
            <strong>Quick Sale (24h)</strong>
            <span>Food, tickets, urgent sales</span>
          </div>
          <div class="boost-option-price">KSh 30</div>
        </div>
        <div class="boost-option" data-package="standard">
          <div class="boost-option-info">
            <strong>Standard (7 days)</strong>
            <span>Most student-to-student sales</span>
          </div>
          <div class="boost-option-price">KSh 50</div>
        </div>
        <div class="boost-option" data-package="premium">
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
  btn.disabled = true;
  statusEl.textContent = 'Sending payment request…';
  statusEl.className = 'boost-status pending';

  try {
    const res = await fetch(`${API_BASE}/payments/boost`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ listingId, phoneNumber: phone, boostType }),
    });

    const data = await res.json();
    if (!res.ok || !data.success) throw new Error(data.error || 'Payment failed');

    statusEl.textContent = '📲 Check your phone for the M-Pesa prompt to complete payment.';
    statusEl.className = 'boost-status success';
    btn.textContent = 'Request sent';
  } catch (err) {
    statusEl.textContent = `⚠️ ${err.message}`;
    statusEl.className = 'boost-status error';
    btn.disabled = false;
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

      const res = await fetch(`${API_BASE}/upload`, {
        method: 'POST',
        body: formData,
      });

      if (!res.ok) throw new Error('Upload failed');
      const data = await res.json();

      uploadedImageUrl = data.url;
      status.textContent = '✅ Photo uploaded';
      status.className = 'image-upload-status success';
    } catch (err) {
      console.warn('Image upload failed:', err.message);
      uploadedImageUrl = null;
      status.textContent = '⚠️ Could not upload photo — listing will be posted without it';
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
        // Honeypot: must be empty for real humans; the hidden input is read here
        // and the server drops any submission that filled it.
        website: (document.getElementById('website') || {}).value || '',
      }),
    });

    const data = await res.json();
    if (!res.ok || !data.success) throw new Error(data.error || 'Payment request failed');

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
    endPaymentWait(false, `⚠️ ${err.message}. Please try again.`);
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
  // or open modal) with a spinner while the request runs; restored in finally.
  const btns = document.querySelectorAll(`.owner-btn[data-listing="${id}"]`);
  btns.forEach(btn => setBtnBusy(btn, true));

  try {
    const res = await fetch(`${API_BASE}/listings/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Owner-Token': token },
      body: JSON.stringify(updates),
    });
    const data = await res.json();
    if (!res.ok || !data.success) throw new Error(data.error || 'Update failed');

    const idx = allListings.findIndex(l => l._id === id);
    if (idx !== -1) allListings[idx] = { ...allListings[idx], ...data.listing, icon: CATEGORY_ICONS[data.listing.category] || allListings[idx].icon };
    renderListings();
    closeModal();
    showToast('✅ Listing updated');
  } catch (err) {
    console.error('Listing update failed:', err.message);
    showToast(`⚠️ ${err.message}`);
  } finally {
    btns.forEach(btn => setBtnBusy(btn, false));
  }
}

async function deleteListing(id) {
  const token = getOwnerToken(id);
  if (!token) { showToast('⚠️ No owner token saved for this listing'); return; }
  const listing = allListings.find(l => l._id === id);
  if (!window.confirm(`Delete "${listing ? listing.title : 'this listing'}"? This cannot be undone.`)) return;

  // Disable this listing's edit/delete buttons while the request runs.
  const btns = document.querySelectorAll(`.owner-btn[data-listing="${id}"]`);
  btns.forEach(btn => setBtnBusy(btn, true));

  try {
    const res = await fetch(`${API_BASE}/listings/${id}`, {
      method: 'DELETE',
      headers: { 'X-Owner-Token': token },
    });
    const data = await res.json();
    if (!res.ok || !data.success) throw new Error(data.error || 'Delete failed');

    allListings = allListings.filter(l => l._id !== id);
    myListings = myListings.filter(l => l._id !== id);
    try { localStorage.removeItem(OWNER_TOKEN_PREFIX + id); } catch (err) {}
    document.getElementById('statListings').textContent = allListings.length;
    renderListings();
    closeModal();
    showToast('🗑️ Listing deleted');
  } catch (err) {
    console.error('Listing delete failed:', err.message);
    showToast(`⚠️ ${err.message}`);
  } finally {
    btns.forEach(btn => setBtnBusy(btn, false));
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
  attachOwnerButtons(grid);
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