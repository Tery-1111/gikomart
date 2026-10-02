const express = require('express');
const router = express.Router();
const { initiateBoost, initiateListing, initiateStorePlan, handleWebhook, checkPaymentStatus } = require('../controllers/paymentController');
const { paymentLimiter, listingCreateLimiter, statusLimiter } = require('../middleware/rateLimiter');
const honeypot = require('../middleware/honeypot');

// Payment initiation triggers M-Pesa STK push (real money) — rate-limit hard.
router.post('/boost', paymentLimiter, initiateBoost);
router.post('/initiate-listing', paymentLimiter, listingCreateLimiter, honeypot, initiateListing);
router.post('/initiate-store-plan', paymentLimiter, listingCreateLimiter, honeypot, initiateStorePlan);
// The webhook must NOT be behind a limiter — it is called by IntaSend's servers
// (shared IPs would trip rate limits). The status endpoint is polled by the
// browser while an STK push is pending, so it gets its own tunable limiter.
router.post('/webhook', handleWebhook);
router.get('/status/:invoiceId', statusLimiter, checkPaymentStatus);

module.exports = router;