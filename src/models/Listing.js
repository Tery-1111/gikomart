const mongoose = require('mongoose');
const listingSchema = new mongoose.Schema({
  title: { type: String, required: true },
  category: { type: String, required: true },
  subcategory: { type: String },
  condition: { type: String, required: true },
  price: { type: Number, required: true },
  description: { type: String, required: true },
  images: [{ type: String }],
  sellerName: { type: String, required: true },
  sellerWhatsapp: { type: String, required: true },
  location: { type: String, default: 'Egerton University, Njoro' },
  status: { type: String, enum: ['active', 'sold', 'deleted'], default: 'active' },
  // Content moderation: flagged/removed listings are hidden from public queries
  // until an admin resolves them. Defaults to 'approved' so existing listings
  // remain visible and new listings go live immediately unless flagged.
  moderationStatus: { type: String, enum: ['approved', 'flagged', 'removed'], default: 'approved' },
  views: { type: Number, default: 0 },
  broadcastSent: { type: Boolean, default: false },
  // Listing lifecycle (paid duration)
  package: { type: String, enum: ['quick', 'standard', 'premium'], required: true },
  expiresAt: { type: Date, required: true },
  // Monetization fields (boosts — independent of listing expiry)
  featured: { type: Boolean, default: false },
  featuredUntil: { type: Date, default: null },
  boostType: { type: String, enum: ['standard', 'rush', null], default: null },
  priorityBroadcast: { type: Boolean, default: false },
  // Ownership gate for update/delete — sha256 of the owner token handed to the
  // payer at payment-initiation time. select:false keeps it out of every
  // public query/response; controllers opt in with .select('+ownerTokenHash').
  ownerTokenHash: { type: String, select: false },
}, { timestamps: true });

listingSchema.index({ status: 1, category: 1, featured: -1, createdAt: -1 });
listingSchema.index({ sellerWhatsapp: 1 });
listingSchema.index({ expiresAt: 1 }); // for the cleanup job

module.exports = mongoose.model('Listing', listingSchema);