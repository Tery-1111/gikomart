/**
 * Server-side input length caps.
 *
 * Single source of truth for the maximum size of user-supplied fields. Enforced
 * in the payment-initiation controllers (before an STK push and before storage),
 * on owner updates, and mirrored by `maxlength` on the Mongoose schemas.
 *
 * Values are character counts (measured after trim). Array caps bound the number
 * of items; where a per-item cap exists it bounds each item's character count.
 */
const caps = {
  listing: {
    title: 120,
    description: 2000,
    sellerName: 80,
    sellerWhatsapp: 20,
    location: 120,
    category: 60,
    subcategory: 60,
    condition: 20,
    images: { maxItems: 6 },
  },
  store: {
    name: 100,
    description: 2000,
    phone: 20,
    whatsapp: 20,
    email: 100,
    location: 120,
    pickup_location: 120,
    opening_hours: 40,
    closing_hours: 40,
    open_days: 60,
    category: 60,
    subcategories: { maxItems: 12, item: 60 },
    payment_methods: { maxItems: 10, item: 40 },
  },
  report: {
    details: 500,
    note: 200,
  },
};

// Freeze recursively so callers cannot widen a cap at runtime.
function deepFreeze(value) {
  for (const nested of Object.values(value)) {
    if (nested && typeof nested === 'object') deepFreeze(nested);
  }
  return Object.freeze(value);
}

module.exports = deepFreeze(caps);
