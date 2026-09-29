/**
 * Rate Limiting Middleware
 *
 * Provides tiered rate limits for different endpoint categories.
 * Uses express-rate-limit with in-memory store (sufficient for single-server).
 * For multi-server deployments, switch to a Redis store.
 *
 * Phase 1C — Security Hardening
 */

const rateLimit = require('express-rate-limit');

// Global: 100 requests per minute per IP
const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many requests — please try again later' },
});

// Upload: 10 per minute per IP
const uploadLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Upload limit reached — please wait before trying again' },
});

// Payment initiation: 5 per minute per IP
const paymentLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Payment request limit reached — please wait before trying again' },
});

// Listing creation (initiate-listing): 5 per minute per IP
const listingCreateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many listing attempts — please wait before trying again' },
});

// Buyer contact acceptance + contact-seller: 20 per minute per IP
const contactLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many contact requests — please wait before trying again' },
});

module.exports = { globalLimiter, uploadLimiter, paymentLimiter, listingCreateLimiter, contactLimiter };
