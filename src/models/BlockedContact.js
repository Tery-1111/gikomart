const mongoose = require('mongoose');

// A blocked seller contact, keyed only by the sha256 of the normalized Kenyan
// number (never the raw number). sourceType/sourceId record what the block was
// derived from; phone blocks have sourceId null. `unique` on contactHash also
// creates its index, so a number cannot be blocked twice.
const blockedContactSchema = new mongoose.Schema({
  contactHash: { type: String, required: true, unique: true },
  sourceType: { type: String, enum: ['listing', 'store', 'phone'], required: true },
  sourceId: { type: String, default: null },
  reason: { type: String, required: true, maxlength: 200 },
  createdBy: { type: String, required: true },
}, { timestamps: true });

module.exports = mongoose.model('BlockedContact', blockedContactSchema);
