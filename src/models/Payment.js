const mongoose = require('mongoose');

const paymentSchema = new mongoose.Schema({
  type: { type: String, enum: ['listing', 'boost', 'store'], required: true },
  listingId: { type: mongoose.Schema.Types.ObjectId, ref: 'Listing' }, // absent until listing payment completes
  listingData: { type: mongoose.Schema.Types.Mixed }, // pending sell-form payload, used only for type:'listing'
  package: { type: String, enum: ['quick', 'standard', 'premium'] }, // used only for type:'listing'
  phoneNumber: { type: String, required: true },
  amount: { type: Number, required: true },
  // Canonical price captured at initiation time. The webhook and admin replay
  // prefer THIS over the live price table, so a price change between initiation
  // and completion never rejects a genuinely paid record. Optional because
  // payment documents created before this field existed have no value; those
  // legacy rows fall back to the live price table.
  expectedAmount: { type: Number, required: false },
  boostType: { type: String, enum: ['featured', 'rush', 'priority_broadcast'] }, // used only for type:'boost'
  storePlan: { type: String, enum: ['starter_weekly', 'standard_monthly', 'pro_monthly'] }, // used only for type:'store'; standard_weekly removed (never sellable)
  storeData: { type: mongoose.Schema.Types.Mixed }, // pending store-form payload, used only for type:'store'
  storeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Store' }, // absent until store payment completes
  invoiceId: { type: String },
  // sha256 of the raw ownership token returned ONCE in the initiate-listing
  // response. The raw token is NEVER stored server-side.
  ownerTokenHash: { type: String },
  status: { type: String, enum: ['pending', 'completed', 'failed'], default: 'pending' },
  // Set by the retention job once the payer number and the payload's contact
  // copies are redacted. Doubles as the idempotency guard so a payment is never
  // stripped twice.
  piiStrippedAt: { type: Date, default: null },
  termsAcceptanceId: { type: mongoose.Schema.Types.ObjectId, ref: 'TermsAcceptance' },
}, { timestamps: true });

// Supports the webhook atomic claim and the status/FAILED lookups, which all
// filter on an exact invoiceId (paymentController.js:305, 315, 433, 455).
// Payment has no other index, and the collection grows one record per payment.
paymentSchema.index({ invoiceId: 1 });

module.exports = mongoose.model('Payment', paymentSchema);