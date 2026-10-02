const mongoose = require('mongoose');

// A user-submitted report against a listing or a store. The reporter IP is kept
// only to deduplicate repeats on the same target within a rolling window and is
// erased by the cleanup job after 30 days; it is never serialized back to any
// caller. `moderationAction` records what an admin DID through the moderation
// endpoints — resolving a report never applies moderation itself.
const reportSchema = new mongoose.Schema({
  targetType: { type: String, enum: ['listing', 'store'], required: true },
  targetId: { type: String, required: true },
  reason: {
    type: String,
    enum: ['scam', 'prohibited_item', 'wrong_info', 'harassment', 'other'],
    required: true,
  },
  details: { type: String, maxlength: 500, default: '' },
  reporterIp: { type: String, default: null },
  status: { type: String, enum: ['open', 'actioned', 'dismissed'], default: 'open' },
  moderationAction: {
    type: String,
    enum: ['none', 'approved', 'flagged', 'removed', 'suspended'],
    default: null,
  },
  resolvedAt: { type: Date, default: null },
  resolvedBy: { type: String, default: null },
  note: { type: String, maxlength: 200, default: '' },
}, { timestamps: true });

reportSchema.index({ targetType: 1, targetId: 1, createdAt: -1 });
reportSchema.index({ status: 1, createdAt: -1 });

module.exports = mongoose.model('Report', reportSchema);
