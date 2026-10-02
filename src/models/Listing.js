const mongoose = require('mongoose');
const listingSchema = new mongoose.Schema({
  title: { type: String, required: true, maxlength: 120 },
  category: { type: String, required: true, maxlength: 60 },
  subcategory: { type: String, maxlength: 60 },
  condition: { type: String, required: true, maxlength: 20 },
  price: { type: Number, required: true },
  description: { type: String, required: true, maxlength: 2000 },
  images: [{ type: String }],
  sellerName: { type: String, required: true, maxlength: 80 },
  sellerWhatsapp: { type: String, required: true, maxlength: 20 },
  location: { type: String, default: 'Egerton University, Njoro', maxlength: 120 },
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
  // The payment that produced this listing. Unique so a duplicate webhook
  // delivery (or a throw mid-processing on the first delivery) cannot create a
  // second listing for the same payment — the webhook catches E11000 and
  // re-reads the existing record instead.
  paymentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Payment' },
  // Optional store linkage — NULL means standalone listing
  store_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Store', default: null },
}, { timestamps: true });

listingSchema.index({ status: 1, category: 1, featured: -1, createdAt: -1 });
listingSchema.index({ sellerWhatsapp: 1 });
listingSchema.index({ expiresAt: 1 }); // for the cleanup job
listingSchema.index({ store_id: 1 }); // store listing queries
listingSchema.index({ paymentId: 1 }, { unique: true, sparse: true }); // webhook idempotency

module.exports = mongoose.model('Listing', listingSchema);