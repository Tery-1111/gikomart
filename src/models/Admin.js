const mongoose = require('mongoose');

/**
 * Admin identity for TOTP two-factor authentication.
 *
 * The ADMIN_KEY in .env remains the "external secret" possession factor; this
 * model stores the TOTP secret that adds a second, time-based factor. There is
 * no password — GikoMart has no user/password model at all, so 2FA is layered
 * on top of the existing admin key rather than replacing it.
 *
 * Phase 2C — Security Hardening
 */
const adminSchema = new mongoose.Schema({
  // Unique admin identity — one record per admin; the primary record is 'owner'
  username: {
    type: String,
    required: true,
    unique: true,
    trim: true,
    lowercase: true,
  },
  // Base32 TOTP secret generated at setup time
  totpSecret: {
    type: String,
    required: true,
    select: false, // never returned in queries
  },
  totpEnabled: {
    type: Boolean,
    default: false,
  },
  // Keep a rolling list of the last used TOTP counters to prevent replay
  lastUsedCounter: {
    type: Number,
    default: 0,
  },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model('Admin', adminSchema);