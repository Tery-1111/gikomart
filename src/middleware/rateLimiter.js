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

// Upload daily ceiling: 100 uploads per IP per rolling 24 hours, layered after
// uploadLimiter to bound Cloudinary storage growth from a single source.
const uploadDailyLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000,
  max: 100,
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

// Admin endpoints: 10 per minute per IP (additive to the global limiter)
const adminLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many admin requests — please try again later' },
});

// Contact release: buyer contact-acceptance returns seller PII, so it gets its
// own long-window budget on top of contactLimiter. The default is 20 per hour
// per IP (tightened from 40 to shrink the phone-harvesting budget) and
// tunable via CONTACT_RELEASE_LIMIT for ops. A missing or
// non-positive value uses 20.
const configuredContactReleaseMax = Number.parseInt(process.env.CONTACT_RELEASE_LIMIT, 10);
const contactReleaseLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: Number.isInteger(configuredContactReleaseMax) && configuredContactReleaseMax > 0 ? configuredContactReleaseMax : 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many contact releases — please try again later' },
});

// Payment status polling: the frontend polls while an STK push is pending, so
// the default is generous (60 per minute per IP) and tunable via the
// STATUS_RATE_LIMIT env var for ops. A missing or non-positive value uses 60.
const configuredStatusMax = Number.parseInt(process.env.STATUS_RATE_LIMIT, 10);
const statusLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: Number.isInteger(configuredStatusMax) && configuredStatusMax > 0 ? configuredStatusMax : 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many status checks — please try again shortly' },
});

// Public report submission: 10 per hour per IP, tunable via REPORT_RATE_LIMIT
// for ops. A missing or non-positive value uses 10.
const configuredReportMax = Number.parseInt(process.env.REPORT_RATE_LIMIT, 10);
const reportLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: Number.isInteger(configuredReportMax) && configuredReportMax > 0 ? configuredReportMax : 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many reports — please try again later' },
});

module.exports = { globalLimiter, uploadLimiter, uploadDailyLimiter, paymentLimiter, listingCreateLimiter, contactLimiter, adminLimiter, statusLimiter, contactReleaseLimiter, reportLimiter };
