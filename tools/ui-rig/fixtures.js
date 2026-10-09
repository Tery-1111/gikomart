// GikoMart UI verification rig — static fixtures.
//
// Plain data only: nothing here requires src/, a database, or credentials.
// Field names, enum values, ids and icons are copied from:
//   - src/config/listingOptions.js  (the 12-category contract, in order)
//   - src/models/Listing.js / Store.js (field names as the API returns them)
//   - src/utils/publicView.js       (list responses omit sellerWhatsapp)
//
// The rig never imports src/ and never touches a database.

// ─── Categories (Step 2c source: src/config/listingOptions.js) ──────────────
// Same ids, display names, icons and order as LISTING_CATEGORIES.
const CATEGORIES = Object.freeze([
  { id: 'food-drinks', name: 'Food & Drinks', icon: '🍔' },
  { id: 'electronics', name: 'Electronics', icon: '📱' },
  { id: 'clothing-fashion', name: 'Clothing & Fashion', icon: '👕' },
  { id: 'furniture-home', name: 'Furniture & Home', icon: '🛋️' },
  { id: 'student-essentials', name: 'Student Essentials', icon: '📚' },
  { id: 'hostel-living', name: 'Hostel Living', icon: '🛏️' },
  { id: 'jobs-services', name: 'Jobs & Services', icon: '💼' },
  { id: 'vehicles', name: 'Vehicles', icon: '🚗' },
  { id: 'accommodation', name: 'Accommodation', icon: '🏠' },
  { id: 'agriculture', name: 'Agriculture', icon: '🌾' },
  { id: 'beauty-personal-care', name: 'Beauty & Personal Care', icon: '💄' },
  { id: 'entertainment-hobbies', name: 'Entertainment & Hobbies', icon: '🎮' },
]);

const CONDITIONS = ['New', 'Like New', 'Excellent', 'Good', 'Fair', 'Poor'];

// ─── Image placeholders the rig serves at /__rig/img/* ──────────────────────
const IMAGE_NAMES = ['square.svg', 'landscape.svg', 'portrait.svg', 'wide.svg', 'tall.svg'];
// aspect-ratio strings used only for SVG generation (not stored anywhere).
const IMAGE_ASPECTS = { 'square.svg': 1, 'landscape.svg': 4 / 3, 'portrait.svg': 3 / 4, 'wide.svg': 16 / 9, 'tall.svg': 9 / 16 };

function imageUrl(name) {
  return `/__rig/img/${name}`;
}

// Cycle deterministically through the five aspect placeholders.
function imageFor(i) {
  return imageUrl(IMAGE_NAMES[i % IMAGE_NAMES.length]);
}

// ─── Stores ────────────────────────────────────────────────────────────────
// rig-s-1: verified, every optional field filled, capacity from the cheapest
// plan (Starter Weekly — the backend's smallest listingLimit, 5).
// rig-s-2: unverified, only required fields.
const STORES = Object.freeze([
  {
    _id: 'rig-s-1',
    name: 'Rig One Campus Mart',
    slug: 'rig-store-one',
    category: 'Electronics',
    description: 'A fully-filled rig store: every optional field set so panel and page layouts can be verified.',
    phone: '0700000099',
    whatsapp: '0700000099',
    email: 'rig-one@example.com',
    location: 'Njoro, near Main Gate',
    pickup_location: 'Hostel C gate',
    opening_hours: '08:00',
    closing_hours: '21:00',
    open_days: 'Mon-Sat',
    payment_methods: ['M-Pesa'],
    subcategories: ['Phones', 'Laptops'],
    logo_url: imageUrl('square.svg'),
    cover_url: imageUrl('wide.svg'),
    status: 'active',
    moderationStatus: 'approved',
    verification_status: 'verified',
    plan: 'starter_weekly',
    listing_limit: 5,
    started_at: daysAgoIso(10),
    expires_at: daysAheadIso(4),
    createdAt: daysAgoIso(10),
  },
  {
    _id: 'rig-s-2',
    name: 'Rig Two Minimal',
    slug: 'rig-store-two',
    category: 'Books',
    description: 'Minimal rig store: required fields only.',
    status: 'active',
    moderationStatus: 'approved',
    verification_status: 'unverified',
    plan: 'pro_monthly',
    listing_limit: 15,
    started_at: daysAgoIso(2),
    expires_at: daysAheadIso(28),
    createdAt: daysAgoIso(2),
  },
]);

// ─── Listings ──────────────────────────────────────────────────────────────
// Exactly 2 per category (24 total), ids rig-l-01 … rig-l-24.
// Composition requirements met below:
//   - 2 listings have exactly 120-character titles (rig-l-03, rig-l-16)
//   - 2 listings have price 1250000 (rig-l-07, rig-l-21)
//   - 3 listings have images: [] (rig-l-02, rig-l-09, rig-l-19)
//   - 6 belong to store rig-s-1 (rig-l-01..rig-l-06)
//   - 4 are marked featured/priorityBroadcast with the model's field names
//   - createdAt spread across the last 30 days
const TITLES = [
  'Samsung Galaxy S22', 'Espresso Combo Deal',            // food-drinks (01,02)
  'HP EliteBook 840 G8', 'Wireless Earbuds Pro',          // electronics (03,04)
  'Leather Jacket Medium', 'Denim Overalls Set',          // clothing-fashion (05,06)
  'Standing Desk Lamp', 'Wooden Bookshelf Used',          // furniture-home (07,08)
  'Calculus Bundle MATH 111', 'Lab Coat Size M',          // student-essentials (09,10)
  'Dorm Bed Frame 4x6', 'Study Table with Chair',         // hostel-living (11,12)
  'Website Design Fast', 'Poster Printing Deal',          // jobs-services (13,14)
  'Toyota Vitz 2014', 'Bicycle Mountain 26in',            // vehicles (15,16)
  'Bed Sitter Njoro', 'Single Room Hostel C',             // accommodation (17,18)
  'Fresh Maize 90kg Bag', 'Broiler Chicks Box',           // agriculture (19,20)
  'Hair Dryer Salon Pro', 'Makeup Brush 12pc Set',        // beauty-personal-care (21,22)
  'Acoustic Guitar Beginner', 'Board Games Bundle',       // entertainment-hobbies (23,24)
];

const DESCRIPTIONS = [
  'Rig fixture description. Flat neutral image placeholders, deterministic prices and dates so browser passes are repeatable.',
  'Second rig fixture for this category. No real photos, no real payments — the rig is a mock API, nothing persists.',
];

const LOCATIONS = ['Njoro', 'Nakuru CBD', 'Hostel C'];

// Listing model image shape: a flat array of http(s) URL strings.
function buildListings() {
  const listings = [];
  CATEGORIES.forEach((cat, catIdx) => {
    for (let k = 0; k < 2; k++) {
      const n = catIdx * 2 + k + 1;             // 1..24
      const id = `rig-l-${String(n).padStart(2, '0')}`;
      const listingIdx = n - 1;

      let title = TITLES[listingIdx];
      if (id === 'rig-l-03' || id === 'rig-l-16') {
        // Exactly 120 characters.
        title = (title + ' ').repeat(Math.ceil(120 / title.length)).slice(0, 120);
      }

      let price = 500 + listingIdx * 173;        // deterministic, varied
      if (id === 'rig-l-07' || id === 'rig-l-21') price = 1250000;

      const inStore = n <= 6;                    // rig-l-01..rig-l-06 → rig-s-1
      // images: rig-l-02, rig-l-09, rig-l-19 are imageless; every other
      // listing has >=1 image cycling through the five SVG placeholders.
      const images = (id === 'rig-l-02' || id === 'rig-l-09' || id === 'rig-l-19')
        ? []
        : [imageFor(listingIdx), imageFor(listingIdx + 2)];

      const featured = (id === 'rig-l-01');
      const priorityBroadcast = (id === 'rig-l-08' || id === 'rig-l-14');
      const rushBoost = (id === 'rig-l-17');

      listings.push({
        _id: id,
        title,
        category: cat.id,
        condition: CONDITIONS[listingIdx % CONDITIONS.length],
        price,
        description: DESCRIPTIONS[listingIdx % DESCRIPTIONS.length],
        sellerName: sellerName(n - 1),
        // List shapes omit sellerWhatsapp (src/utils/publicView.js).
        location: LOCATIONS[listingIdx % LOCATIONS.length],
        images,
        status: 'active',
        moderationStatus: 'approved',
        featured,
        priorityBroadcast,
        boostType: featured ? 'featured' : (priorityBroadcast ? 'priority_broadcast' : (rushBoost ? 'rush' : null)),
        views: (n * 7) % 240,
        broadcastSent: featured || priorityBroadcast || rushBoost,
        package: inStore ? 'store' : 'standard',
        // createdAt spread across the last 30 days: rig-l-01 oldest-ish,
        // rig-l-24 newest (30d → today, equally spaced).
        createdAt: daysAgoIso(30 - (listingIdx * 30) / 23),
        featuredUntil: featured ? daysAheadIso(1) : null,
        ...(inStore ? { store_id: 'rig-s-1', store_name: 'Rig One Campus Mart', store_slug: 'rig-store-one' } : { store_id: null, store_name: null, store_slug: null }),
      });
    }
  });
  return listings;
}

function sellerName(i) {
  const names = ['Brian', 'Grace', 'Kevin', 'James', 'Wanjiku', 'Otieno', 'Chebet', 'Amina'];
  return names[i % names.length];
}

function daysAgoIso(days) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

function daysAheadIso(days) {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

const LISTINGS = Object.freeze(buildListings());

// ─── Grant claims (status is decided by claim id, not scenario) ─────────────
// Storage keys (Step 2d, public/assets/js/app.js):
//   gikomart_grantToken:<claimId>  → raw claim token
//   gikomart_grantMeta:<claimId>   → JSON { type, whatsapp, plan }
const GRANT_CLAIMS = Object.freeze({
  'rig-claim-pending': { status: 'pending', type: 'listing' },
  'rig-claim-approved': { status: 'approved', type: 'listing' },
  'rig-claim-rejected': { status: 'rejected', type: 'listing' },
});

// Grant meta shape written by handleGrantRequestSubmit (app.js):
//   { type, whatsapp, plan } — plan is the option label the seller selected.
const GRANT_META_TEMPLATE = Object.freeze({ type: 'listing', whatsapp: '0712345678', plan: 'Standard (7 days)' });

// Public store page payload is listingView-shaped; the rig serves its store
// objects through the same key names the real storeView returns minus contact
// PII (phone/whatsapp/email), matching src/utils/publicView.js behaviour.
function publicStoreView(store) {
  const { phone, whatsapp, email, ...publicFields } = store;
  return publicFields;
}

// Owner-view shapes include contact PII (used by renderStoreManagementPanel).
function ownerStoreView(store, listingCount) {
  return { ...store, listingCount };
}

module.exports = {
  CATEGORIES,
  CONDITIONS,
  IMAGE_NAMES,
  IMAGE_ASPECTS,
  imageUrl,
  imageFor,
  STORES,
  LISTINGS,
  GRANT_CLAIMS,
  GRANT_META_TEMPLATE,
  publicStoreView,
  ownerStoreView,
};
