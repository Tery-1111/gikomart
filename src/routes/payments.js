const express = require('express');
const router = express.Router();
const { initiateBoost, initiateListing, handleWebhook, checkPaymentStatus } = require('../controllers/paymentController');
const { paymentLimiter, listingCreateLimiter } = require('../middleware/rateLimiter');
const honeypot = require('../middleware/honeypot');

// Payment initiation triggers M-Pesa STK push (real money) — rate-limit hard.
router.post('/boost', paymentLimiter, initiateBoost);
router.post('/initiate-listing', paymentLimiter, listingCreateLimiter, honeypot, initiateListing);
// Webhook and status-check must NOT be behind the same limiter — the webhook is
// called by IntaSend's servers (shared IPs would trip rate limits).
router.post('/webhook', handleWebhook);
router.get('/status/:invoiceId', checkPaymentStatus);

module.exports = router;