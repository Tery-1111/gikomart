const mongoose = require('mongoose');

/**
 * GrantRequest — an administrative free-access request.
 *
 * This is NOT a payment: it records that a seller asked the GikoMart admin for
 * a free package, the admin's manual decision, and (after the seller redeems)
 * the resource the grant produced. No IntaSend transaction, no amount, no
 * invoice. The producing record's `_id` is passed to the shared provisioning
 * function (`createResourceForPayment`) as the payment-shaped id, so the
 * existing unique-sparse `paymentId` index on Listing/Store provides the same
 * duplicate-provisioning protection the paid path relies on.
 */
const grantRequestSchema = new mongoose.Schema({
  // Contact value, normalized to 254[17]\d{8}. Contact only — never an identity
  // and never an ownership credential (that is always the owner token).
  whatsapp: { type: String, required: true, maxlength: 20 },
  // HMAC of the normalized number, used only to honor existing contact blocks.
  contactHash: { type: String, default: null },
  // sha256 of the one-time claim token handed to the requesting browser. The
  // raw token is NEVER stored (this is the grant analogue of ownerTokenHash).
  claimTokenHash: { type: String, required: true, unique: true },
  type: { type: String, enum: ['listing', 'store'], required: true },
  // Exactly one of these is set, matching `type` (enforced below).
  package: { type: String, enum: ['quick', 'standard', 'premium'], default: null },
  storePlan: { type: String, enum: ['starter_weekly', 'standard_monthly', 'pro_monthly'], default: null },
  status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
  // QA marker: set through the admin API to flag an agent-submitted test
  // request so the queue can distinguish it from a real seller. Cosmetic
  // only — the lifecycle (approve/reject/redeem) is deliberately identical.
  isTest: { type: Boolean, default: false },
  // Administrative decision trail (parity with Payment.grantedBy/grantedAt).
  decidedBy: { type: String, default: null },
  decidedAt: { type: Date, default: null },
  // Set only after the resource is successfully created, so a failed
  // provisioning attempt leaves status 'approved' and a safe retry possible.
  provisionedAt: { type: Date, default: null },
  listingId: { type: mongoose.Schema.Types.ObjectId, ref: 'Listing', default: null },
  storeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Store', default: null },
}, { timestamps: true });

// Require the package that matches the requested resource type.
// Mongoose 9 invokes document middleware WITHOUT a callback, so a callback-style
// `next` here threw "TypeError: next is not a function" on every create/save —
// the production 500 on POST /api/grants (2026-10-04). Sync throw-style keeps
// the same rejection semantics and messages; the API tests inject fake models
// so tests/grantRequestModel.test.mjs guards the real schema.
grantRequestSchema.pre('validate', function ensureMatchingPackage() {
  if (this.type === 'listing' && !this.package) {
    throw new Error('package is required for a listing grant');
  }
  if (this.type === 'store' && !this.storePlan) {
    throw new Error('storePlan is required for a store grant');
  }
});

// Admin queue: newest request per status first.
grantRequestSchema.index({ status: 1, createdAt: -1 });

module.exports = mongoose.model('GrantRequest', grantRequestSchema);
