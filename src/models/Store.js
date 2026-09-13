const mongoose = require('mongoose');

const storeSchema = new mongoose.Schema({
  // Identity
  name:          { type: String, required: true, trim: true },
  slug:          { type: String, required: true, unique: true, lowercase: true, trim: true },
  description:   { type: String, default: '' },
  logo_url:      { type: String, default: null },
  cover_url:     { type: String, default: null },

  // Business
  category:      { type: String, required: true },
  subcategories: [{ type: String }],

  // Contact
  phone:         { type: String, default: '' },
  whatsapp:      { type: String, default: '' },
  email:         { type: String, default: '' },

  // Location
  campus:           { type: String, default: 'Egerton University' },
  location:         { type: String, default: '' },
  pickup_location:  { type: String, default: '' },

  // Operations
  opening_hours:       { type: String, default: '' },
  closing_hours:       { type: String, default: '' },
  open_days:           { type: String, default: '' },
  delivery_available:  { type: Boolean, default: false },
  pickup_available:    { type: Boolean, default: true },
  payment_methods:     [{ type: String }],

  // Trust
  verification_status: { type: String, enum: ['unverified', 'pending', 'verified'], default: 'unverified' },

  // Ownership — same pattern as Listing
  ownerTokenHash: { type: String, select: false },

  // Plan
  plan:           { type: String, enum: ['starter_weekly', 'standard_weekly', 'standard_monthly', 'pro_monthly'], required: true },
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

module.exports = mongoose.model('Store', storeSchema);
