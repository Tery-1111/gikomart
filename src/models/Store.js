const mongoose = require('mongoose');

const storeSchema = new mongoose.Schema({
  // Identity
  name:          { type: String, required: true, trim: true, maxlength: 100 },
  slug:          { type: String, required: true, unique: true, lowercase: true, trim: true },
  description:   { type: String, default: '', maxlength: 2000 },
  logo_url:      { type: String, default: null },
  cover_url:     { type: String, default: null },

  // Business
  category:      { type: String, required: true, maxlength: 60 },
  subcategories: [{ type: String }],

  // Contact
  phone:         { type: String, default: '', maxlength: 20 },
  whatsapp:      { type: String, default: '', maxlength: 20 },
  email:         { type: String, default: '', maxlength: 100 },

  // Location
  campus:           { type: String, default: 'Egerton University' },
  location:         { type: String, default: '', maxlength: 120 },
  pickup_location:  { type: String, default: '', maxlength: 120 },

  // Operations
  opening_hours:       { type: String, default: '', maxlength: 40 },
  closing_hours:       { type: String, default: '', maxlength: 40 },
  open_days:           { type: String, default: '', maxlength: 60 },
  delivery_available:  { type: Boolean, default: false },
  pickup_available:    { type: Boolean, default: true },
  payment_methods:     [{ type: String }],

  // Trust
  verification_status: { type: String, enum: ['unverified', 'pending', 'verified'], default: 'unverified' },
  // Admin moderation, mirroring Listing.moderationStatus. 'removed' also flips
  // status to 'suspended' so the store drops out of public reads.
  moderationStatus: { type: String, enum: ['approved', 'flagged', 'removed'], default: 'approved' },

  // Ownership — same pattern as Listing
  ownerTokenHash: { type: String, select: false },

  // The payment that produced this store. Unique so a duplicate webhook
  // delivery cannot create a second store for the same payment.
  paymentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Payment' },

  // Plan
  plan:           { type: String, enum: ['starter_weekly', 'standard_monthly', 'pro_monthly'], required: true }, // standard_weekly removed (never sellable)
  plan_price:     { type: Number, required: true },
  plan_duration:  { type: Number, required: true },
  listing_limit:  { type: Number, required: true },
  started_at:     { type: Date, required: true },
  expires_at:     { type: Date, required: true },

  // Status
  status:         { type: String, enum: ['active', 'expired', 'suspended'], default: 'active' },
}, { timestamps: true });

// Note: `slug` needs no explicit index — `unique: true` on the field already
// creates one; declaring both triggers a Mongoose duplicate-index warning.
storeSchema.index({ ownerTokenHash: 1 }, { unique: true });
storeSchema.index({ expires_at: 1 });
storeSchema.index({ status: 1, category: 1, createdAt: -1 });
storeSchema.index({ paymentId: 1 }, { unique: true, sparse: true }); // webhook idempotency

module.exports = mongoose.model('Store', storeSchema);
