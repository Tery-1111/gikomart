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
  views: { type: Number, default: 0 },
  broadcastSent: { type: Boolean, default: false },
  // Monetization fields
  featured: { type: Boolean, default: false },
  featuredUntil: { type: Date, default: null },
  boostType: { type: String, enum: ['standard', 'rush', null], default: null },
  priorityBroadcast: { type: Boolean, default: false },
}, { timestamps: true });
// Compound index matching the actual getListings query shape:
// filters on status/category, sorts by featured then createdAt
listingSchema.index({ status: 1, category: 1, featured: -1, createdAt: -1 });
listingSchema.index({ sellerWhatsapp: 1 });
module.exports = mongoose.model('Listing', listingSchema);