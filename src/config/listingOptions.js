// Finite option sets for listing/store inputs, kept in one place so the
// payment-initiated create path and the owner update path validate against the
// exact same values. These are the only conditions the UI ever produces.
const VALID_CONDITIONS = Object.freeze([
  'New',
  'Like New',
  'Excellent',
  'Good',
  'Fair',
  'Poor',
]);

// ─── Canonical listing category contract ───────────────────────────────────
// Single source of truth for the listing taxonomy. The stable `id` is the
// value stored on Listing documents and sent by clients; `name`/`icon` are
// display metadata. `legacyNames` lists pre-canonical display-name values that
// may exist on records created before this contract — they are mapped for
// display and for legacy stored payloads, never accepted as new input.
// 'Free Stuff' is deliberately absent: it is not a category and legacy records
// carrying it are never reclassified.
const LISTING_CATEGORIES = Object.freeze([
  { id: 'food-drinks', name: 'Food & Drinks', icon: '🍔', legacyNames: [] },
  { id: 'electronics', name: 'Electronics', icon: '📱', legacyNames: ['Electronics'] },
  { id: 'clothing-fashion', name: 'Clothing & Fashion', icon: '👕', legacyNames: ['Clothing'] },
  { id: 'furniture-home', name: 'Furniture & Home', icon: '🛋️', legacyNames: ['Furniture'] },
  { id: 'student-essentials', name: 'Student Essentials', icon: '📚', legacyNames: ['Student Essentials'] },
  { id: 'hostel-living', name: 'Hostel Living', icon: '🛏️', legacyNames: ['Hostel Living'] },
  { id: 'jobs-services', name: 'Jobs & Services', icon: '💼', legacyNames: ['Jobs & Services'] },
  { id: 'vehicles', name: 'Vehicles', icon: '🚗', legacyNames: ['Vehicles'] },
  { id: 'accommodation', name: 'Accommodation', icon: '🏠', legacyNames: ['Property'] },
  { id: 'agriculture', name: 'Agriculture', icon: '🌾', legacyNames: ['Agriculture'] },
  { id: 'beauty-personal-care', name: 'Beauty & Personal Care', icon: '💄', legacyNames: [] },
  { id: 'entertainment-hobbies', name: 'Entertainment & Hobbies', icon: '🎮', legacyNames: [] },
]);

const VALID_CATEGORY_IDS = Object.freeze(LISTING_CATEGORIES.map((c) => c.id));

// True only for an exact canonical stable ID. New client input must pass this.
function isValidListingCategory(value) {
  return typeof value === 'string' && VALID_CATEGORY_IDS.includes(value);
}

// Map a pre-canonical display name to its canonical ID, or null when the value
// has no unambiguous mapping (e.g. 'Free Stuff'). Applied ONLY to data stored
// before the contract existed (payment/grant payloads) — never to new input.
const LEGACY_LISTING_CATEGORY_NAMES = Object.freeze(
  new Map(LISTING_CATEGORIES.flatMap((c) => (c.legacyNames || []).map((legacy) => [legacy, c.id]))),
);

function normalizeLegacyListingCategory(value) {
  return LEGACY_LISTING_CATEGORY_NAMES.get(value) || null;
}

// Display name for any stored value: canonical name, legacy-mapped name, or
// the raw value (unknown/legacy categories must render safely, never crash).
function categoryDisplayName(value) {
  const canonical = LISTING_CATEGORIES.find((c) => c.id === value);
  if (canonical) return canonical.name;
  const mappedId = LEGACY_LISTING_CATEGORY_NAMES.get(value);
  if (mappedId) {
    const mapped = LISTING_CATEGORIES.find((c) => c.id === mappedId);
    if (mapped) return mapped.name;
  }
  return String(value ?? '');
}

module.exports = {
  VALID_CONDITIONS,
  LISTING_CATEGORIES,
  VALID_CATEGORY_IDS,
  isValidListingCategory,
  normalizeLegacyListingCategory,
  categoryDisplayName,
};
