const crypto = require('crypto');
const Listing = require('../models/Listing');
const Payment = require('../models/Payment');
const logger = require('../config/logger');
const { broadcastListing } = require('../services/whatsappService');
const { checkListing } = require('../services/moderationService');
const { initiateBoostPayment, initiateListingPayment, BOOST_PRICES, LISTING_PRICES } = require('../services/paymentService');

function extractErrorMessage(err) {
  return err.message || err.response?.data?.detail || JSON.stringify(err.response?.data) || 'Unknown payment error';
}

// Initiate a boost payment (existing listing)
exports.initiateBoost = async (req, res) => {
  try {
    const { listingId, phoneNumber, boostType } = req.body;

    if (!BOOST_PRICES[boostType]) {
      return res.status(400).json({ success: false, error: 'Invalid boost type' });
    }

    const listing = await Listing.findById(listingId);
    if (!listing) {
      return res.status(404).json({ success: false, error: 'Listing not found' });
    }

    const apiRef = `boost_${listingId}_${Date.now()}`;
    const { response, amount } = await initiateBoostPayment({ phoneNumber, boostType, apiRef });

    const invoiceId = response?.invoice?.invoice_id || response?.id || null;

    await Payment.create({
      type: 'boost',
      listingId,
      phoneNumber,
      amount,
      boostType,
      invoiceId,
      status: 'pending',
    });

    res.json({ success: true, message: 'STK push sent. Check your phone.', invoiceId, amount });
  } catch (err) {
    const errMsg = extractErrorMessage(err);
    logger.error('Boost payment error', { error: errMsg });
    res.status(500).json({ success: false, error: errMsg });
  }
};

// Initiate a listing payment (new listing — created only after payment confirms)
exports.initiateListing = async (req, res) => {
  try {
    const { phoneNumber, package: pkg, listingData } = req.body;

    if (!LISTING_PRICES[pkg]) {
      return res.status(400).json({ success: false, error: 'Invalid listing package' });
    }
    if (!listingData || typeof listingData !== 'object') {
      return res.status(400).json({ success: false, error: 'Missing listing details' });
    }

    // Validate every field the Listing model requires BEFORE starting the STK push —
    // once payment completes, the webhook creates the listing from this data, and a
    // failed create at that point would mean the user paid but got nothing.
    const VALID_CONDITIONS = ['New', 'Like New', 'Excellent', 'Good', 'Fair', 'Poor'];
    const errors = [];
    if (typeof listingData.title !== 'string' || !listingData.title.trim()) errors.push('title');
    if (typeof listingData.category !== 'string' || !listingData.category.trim()) errors.push('category');
    if (!VALID_CONDITIONS.includes(listingData.condition)) errors.push('condition');
    const price = Number(listingData.price);
    if (!Number.isFinite(price) || price < 0) errors.push('price');
    if (typeof listingData.description !== 'string' || !listingData.description.trim()) errors.push('description');
    if (typeof listingData.sellerName !== 'string' || !listingData.sellerName.trim()) errors.push('sellerName');
    if (typeof listingData.sellerWhatsapp !== 'string' || !listingData.sellerWhatsapp.trim()) errors.push('sellerWhatsapp');
    if (errors.length > 0) {
      return res.status(400).json({ success: false, error: `Invalid or missing listing details: ${errors.join(', ')}` });
    }
    // Normalize price to a proper number so it round-trips through the Mixed-type
    // payment record into Listing.create() cleanly.
    listingData.price = price;

    // Ownership token: the raw token is returned ONCE in this response (the
    // frontend saves it in localStorage) and is never stored server-side —
    // only its sha256 hash persists on the Payment record. The webhook later
    // copies this hash onto the created Listing so update/delete can be gated.
    const rawOwnerToken = crypto.randomBytes(24).toString('hex');
    const ownerTokenHash = crypto.createHash('sha256').update(rawOwnerToken).digest('hex');

    const apiRef = `listing_${Date.now()}`;
    const { response, amount } = await initiateListingPayment({ phoneNumber, package: pkg, apiRef });

    const invoiceId = response?.invoice?.invoice_id || response?.id || null;

    await Payment.create({
      type: 'listing',
      phoneNumber,
      amount,
      package: pkg,
      listingData,
      ownerTokenHash,
      invoiceId,
      status: 'pending',
    });

    res.json({ success: true, message: 'STK push sent. Check your phone.', invoiceId, amount, ownerToken: rawOwnerToken });
  } catch (err) {
    const errMsg = extractErrorMessage(err);
    logger.error('Listing payment error', { error: errMsg });
    res.status(500).json({ success: false, error: errMsg });
  }
};

// Webhook: IntaSend calls this when payment status changes
exports.handleWebhook = async (req, res) => {
  try {
    const receivedChallenge = req.body.challenge;
    if (receivedChallenge !== process.env.INTASEND_WEBHOOK_CHALLENGE) {
      logger.error('Webhook challenge mismatch', { body: JSON.stringify(req.body) });
      return res.status(401).json({ success: false, error: 'Invalid webhook challenge' });
    }

    const { invoice_id, state } = req.body;

    if (state === 'COMPLETE') {
      // Atomic idempotency guard: transition the payment to 'completed' and mark
      // it as claimed in a single operation. Webhooks can be delivered more than
      // once (provider retries, duplicate notifications) and possibly concurrently.
      // Because the filter excludes payments already 'completed', only ONE of the
      // concurrent deliveries can match and update the document — the loser gets
      // null back and skips all side effects (listing creation, broadcast, boosts).
      // This closes the check-then-act race between reading the status and saving it.
      const payment = await Payment.findOneAndUpdate(
        { invoiceId: invoice_id, status: { $ne: 'completed' } },
        { status: 'completed' },
        { new: true }
      );

      if (!payment) {
        // The atomic update matched nothing. Find out why: either the payment
        // record doesn't exist (404) or it was already processed by a duplicate
        // delivery (200). Either way, return before any side effects.
        const existing = await Payment.findOne({ invoiceId: invoice_id });
        if (!existing) {
          return res.status(404).json({ success: false, error: 'Payment record not found' });
        }
        return res.status(200).json({ success: true, message: 'Payment already processed' });
      }

      if (payment.type === 'listing') {
        const pricing = LISTING_PRICES[payment.package];
        // Content moderation gate: flagged listings are created (payment already
        // completed) but hidden from public views and NOT broadcast.
        const moderation = checkListing(payment.listingData || {});
        const listing = await Listing.create({
          ...payment.listingData,
          package: payment.package,
          expiresAt: new Date(Date.now() + pricing.durationMs),
          moderationStatus: moderation.approved ? 'approved' : 'flagged',
          // Only the hash is copied — the raw token never touches the database.
          ownerTokenHash: payment.ownerTokenHash,
        });
        // Record which listing this payment produced (Payment.listingId is
        // designed to stay absent until the listing payment completes) so the
        // status endpoint can tell the payer which listing they now own.
        payment.listingId = listing._id;
        await payment.save();
        if (!moderation.approved) {
          logger.warn('Listing flagged by moderation', { listingId: String(listing._id), flaggedBy: moderation.flaggedBy });
          return res.status(200).json({ success: true });
        }
        broadcastListing(listing).catch(err =>
  logger.warn('WhatsApp broadcast skipped (Whapi unavailable)', { error: err.message })
);
      } else if (payment.type === 'boost') {
        const listing = await Listing.findById(payment.listingId);
        if (listing) {
          if (payment.boostType === 'featured') {
            listing.featured = true;
            listing.boostType = 'standard';
            listing.featuredUntil = new Date(Date.now() + 24 * 60 * 60 * 1000);
          } else if (payment.boostType === 'rush') {
            listing.featured = true;
            listing.boostType = 'rush';
            listing.featuredUntil = new Date(Date.now() + 72 * 60 * 60 * 1000);
          } else if (payment.boostType === 'priority_broadcast') {
            listing.priorityBroadcast = true;
          }
          await listing.save();
        }
      }
    } else if (state === 'FAILED') {
      const payment = await Payment.findOne({ invoiceId: invoice_id });
      if (!payment) {
        return res.status(404).json({ success: false, error: 'Payment record not found' });
      }
      payment.status = 'failed';
      await payment.save();
    }

    res.status(200).json({ success: true });
  } catch (err) {
    logger.error('Webhook error', { error: err.message });
    res.status(500).json({ success: false, error: err.message });
  }
};

// Status check: the frontend polls this after initiating a listing payment to
// learn (a) whether the STK push completed and (b) the id of the listing the
// webhook created — the point at which the client can re-key its saved owner
// token from invoiceId to the actual listing id. Gated by knowledge of the
// invoiceId issued at initiate time; returns no sensitive material.
exports.checkPaymentStatus = async (req, res) => {
  try {
    const payment = await Payment.findOne({ invoiceId: req.params.invoiceId });
    if (!payment) {
      return res.status(404).json({ success: false, error: 'Payment record not found' });
    }
    res.json({
      success: true,
      type: payment.type,
      status: payment.status,
      listingId: payment.listingId || null,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};