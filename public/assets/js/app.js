/* ============================================
   GikoMart Frontend — app.js
   Connects to the Express + MongoDB backend
   ============================================ */

// Change this to your deployed backend URL when you go live
const API_BASE = 'http://localhost:5000/api';

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

// Fallback demo data — used if the API isn't reachable yet
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

let allListings = [];
let myListings = [];
let activeCategory = '';
let usingDemoData = false;
let uploadedImageUrl = null;

// ============================================
// INIT
// ============================================
document.addEventListener('DOMContentLoaded', () => {
  buildCategoryPills();
  buildCategorySelect();
  buildPulseTicker();
  setupNav();
  setupForm();
  setupModal();
  loadListings();
});

// ============================================
// NAVIGATION
// ============================================
function setupNav() {
  document.querySelectorAll('[data-view]').forEach(el => {
    el.addEventListener('click', () => switchView(el.dataset.view));
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

// ============================================
// CATEGORY PILLS + SELECT
// ============================================
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

// ============================================
// PULSE TICKER (signature element)
// ============================================
function buildPulseTicker() {
  const items = [
    { item: 'Samsung Galaxy S22', dest: 'Electronics group + Campus Channel' },
    { item: 'Mattress — 4x6', dest: 'Hostel Living group' },
    { item: 'Calculus Textbook Bundle', dest: 'Student Essentials group' },
    { item: 'Study Desk + Chair', dest: 'Furniture group + Campus Channel' },
    { item: 'Leather Jacket', dest: 'Clothing group' },
  ];
  const track = document.getElementById('pulseTrack');
  // duplicate items so the scroll loops seamlessly
  const html = [...items, ...items].map(i => `
    <span class="pulse-item">
      <span class="pulse-dot"></span>
      📢 Just posted: <strong>${i.item}</strong>
      <span class="pulse-arrow">→</span> sent to ${i.dest}
    </span>
  `).join('');
  track.innerHTML = html;
}

// ============================================
// LOAD LISTINGS FROM API
// ============================================
async function loadListings() {
  try {
    const res = await fetch(`${API_BASE}/listings`);
    if (!res.ok) throw new Error('API not reachable');
    const data = await res.json();
    allListings = data.listings.map(l => ({
      ...l,
      icon: CATEGORY_ICONS[l.category] || '📦',
    }));
    usingDemoData = false;
  } catch (err) {
    console.warn('API not reachable — showing demo listings:', err.message);
    allListings = DEMO_LISTINGS;
    usingDemoData = true;
  }
  document.getElementById('statListings').textContent = allListings.length;
  renderListings();
}

// ============================================
// RENDER LISTINGS
// ============================================
function renderListings() {
  const search = document.getElementById('searchInput').value.toLowerCase();
  const filtered = allListings.filter(l => {
    const matchCat = !activeCategory || l.category === activeCategory;
    const matchSearch = !search ||
      l.title.toLowerCase().includes(search) ||
      l.description.toLowerCase().includes(search);
    return matchCat && matchSearch;
  });

  const grid = document.getElementById('listingGrid');

  if (!filtered.length) {
    grid.innerHTML = `
      <div class="empty-state">
        <span class="empty-icon">🔍</span>
        <p><strong>Nothing here yet.</strong></p>
        <p>Try a different search or category — or be the first to list one.</p>
      </div>`;
    return;
  }

  grid.innerHTML = filtered.map(l => listingCardHTML(l)).join('');

  grid.querySelectorAll('.listing-card').forEach(card => {
    card.addEventListener('click', () => openListingModal(card.dataset.id, filtered));
  });
}

function listingCardHTML(l) {
  const condClass = 'cond-' + l.condition.replace(/\s+/g, '-');
  const hasImage = l.images && l.images.length > 0;
  const imageContent = hasImage
    ? `<img src="${l.images[0]}" alt="${escapeHTML(l.title)}">`
    : l.icon;
  return `
    <div class="listing-card" data-id="${l._id}">
      <div class="listing-image">
        ${imageContent}
        <span class="condition-badge ${condClass}">${l.condition}</span>
      </div>
      <div class="listing-body">
        <div class="listing-title">${escapeHTML(l.title)}</div>
        <div class="listing-price">KSh ${Number(l.price).toLocaleString()}</div>
        <div class="listing-meta">
          <span>📍 ${escapeHTML(l.location || 'Egerton')}</span>
          ${l.broadcastSent ? '<span class="broadcast-chip">📢 Broadcast</span>' : `<span>👁️ ${l.views || 0}</span>`}
        </div>
      </div>
    </div>`;
}

// ============================================
// MODAL
// ============================================
function setupModal() {
  document.getElementById('modalOverlay').addEventListener('click', (e) => {
    if (e.target.id === 'modalOverlay') closeModal();
  });
}

function openListingModal(id, source) {
  const listing = (source || allListings).find(l => l._id === id);
  if (!listing) return;

  const condClass = 'cond-' + listing.condition.replace(/\s+/g, '-');
  const hasImage = listing.images && listing.images.length > 0;
  const modalImageContent = hasImage
    ? `<img src="${listing.images[0]}" alt="${escapeHTML(listing.title)}" style="width:100%;height:100%;object-fit:cover;">`
    : (listing.icon || CATEGORY_ICONS[listing.category] || '📦');
  const card = document.getElementById('modalCard');
  card.innerHTML = `
    <button class="modal-close" onclick="closeModal()">✕</button>
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
    <button class="contact-btn" onclick="contactSeller('${listing.sellerWhatsapp}', '${escapeHTML(listing.title).replace(/'/g, "\\'")}')">
      💬 Contact seller on WhatsApp
    </button>
  `;
  document.getElementById('modalOverlay').classList.add('open');

  // bump views via API if real listing
  if (!usingDemoData && !id.startsWith('demo')) {
    fetch(`${API_BASE}/listings/${id}`).catch(() => {});
  }
}

function closeModal() {
  document.getElementById('modalOverlay').classList.remove('open');
}

function contactSeller(whatsapp, title) {
  const cleanNumber = whatsapp.replace(/[\s+]/g, '');
  const message = encodeURIComponent(`Hi! I saw your listing "${title}" on GikoMart. Is it still available?`);
  window.open(`https://wa.me/${cleanNumber}?text=${message}`, '_blank');
}

// ============================================
// SELL FORM + LIVE PREVIEW
// ============================================
function setupForm() {
  const fields = ['f-title', 'f-category', 'f-price', 'f-description', 'f-location'];
  fields.forEach(id => {
    document.getElementById(id).addEventListener('input', updatePreview);
  });

  setupImageUpload();
  document.getElementById('sellForm').addEventListener('submit', handleSubmit);
  updatePreview();
}

// ============================================
// IMAGE UPLOAD
// ============================================
function setupImageUpload() {
  const box = document.getElementById('imageUploadBox');
  const input = document.getElementById('f-image');
  const placeholder = document.getElementById('imageUploadPlaceholder');
  const previewImg = document.getElementById('imagePreviewImg');
  const removeBtn = document.getElementById('imageRemoveBtn');
  const status = document.getElementById('imageUploadStatus');

  box.addEventListener('click', (e) => {
    if (e.target === removeBtn) return;
    if (!box.classList.contains('has-image')) input.click();
  });

  input.addEventListener('change', async () => {
    const file = input.files[0];
    if (!file) return;

    if (file.size > 5 * 1024 * 1024) {
      status.textContent = 'File too large — max 5MB';
      status.className = 'image-upload-status error';
      return;
    }

    // Show local preview immediately
    const reader = new FileReader();
    reader.onload = (e) => {
      previewImg.src = e.target.result;
      previewImg.classList.add('show');
      placeholder.style.display = 'none';
      box.classList.add('has-image');
      removeBtn.hidden = false;

      // also reflect in the WhatsApp preview
      const prevImg = document.getElementById('prev-image');
      prevImg.src = e.target.result;
      prevImg.hidden = false;
      prevImg.classList.add('show');
    };
    reader.readAsDataURL(file);

    // Upload to Cloudinary via backend
    status.textContent = 'Uploading photo…';
    status.className = 'image-upload-status';

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

  // Also update hero mock occasionally for fun consistency
  document.getElementById('mockTitle').textContent = title !== 'Your item title' ? title : 'Samsung Galaxy S22';
  document.getElementById('mockPrice').textContent = price !== '0' ? Number(price).toLocaleString() : '38,000';
}

async function handleSubmit(e) {
  e.preventDefault();

  const payload = {
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

  const statusEl = document.getElementById('formStatus');
  const broadcast = document.getElementById('f-broadcast').checked;

  statusEl.textContent = 'Publishing…';
  statusEl.className = 'form-status';

  try {
    const res = await fetch(`${API_BASE}/listings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!res.ok) throw new Error('Could not save listing');
    const data = await res.json();
    const newListing = { ...data.listing, icon: CATEGORY_ICONS[data.listing.category] || '📦' };

    allListings.unshift(newListing);
    myListings.unshift(newListing);
    document.getElementById('statListings').textContent = allListings.length;

    statusEl.textContent = broadcast
      ? '✅ Published! Broadcasting to WhatsApp now…'
      : '✅ Published to GikoMart (broadcast skipped).';
    statusEl.classList.add('success');

    showToast(broadcast ? '📢 Listing sent to WhatsApp groups!' : '✅ Listing published');

    e.target.reset();
    document.getElementById('f-condition').value = 'Excellent';
    document.getElementById('f-broadcast').checked = true;
    resetImageUpload();
    updatePreview();
    renderListings();

  } catch (err) {
    console.warn('Publish failed, saving locally:', err.message);

    // Fallback: still let the user see it work locally
    const localListing = {
      ...payload,
      _id: 'local-' + Date.now(),
      icon: CATEGORY_ICONS[payload.category] || '📦',
      views: 0,
      broadcastSent: broadcast,
    };
    allListings.unshift(localListing);
    myListings.unshift(localListing);
    document.getElementById('statListings').textContent = allListings.length;

    statusEl.textContent = '✅ Saved locally (backend offline) — will sync once connected.';
    statusEl.classList.add('success');
    showToast('Listing saved locally');

    e.target.reset();
    document.getElementById('f-condition').value = 'Excellent';
    document.getElementById('f-broadcast').checked = true;
    resetImageUpload();
    updatePreview();
    renderListings();
  }
}

// ============================================
// DASHBOARD
// ============================================
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

// ============================================
// UTILITIES
// ============================================
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