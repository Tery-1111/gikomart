const mongoose = require('mongoose');

// Tracks every image uploaded through /api/upload so cleanupService can
// destroy Cloudinary assets that were never attached to a listing or store.
const uploadSchema = new mongoose.Schema(
  {
    publicId: { type: String, required: true, unique: true },
    url: { type: String, required: true },
    attached: { type: Boolean, default: false },
    createdAt: { type: Date, default: Date.now, index: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Upload', uploadSchema);
