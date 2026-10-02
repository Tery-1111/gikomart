const crypto = require('crypto');
const Listing = require('../models/Listing');
const Payment = require('../models/Payment');
const logger = require('../config/logger');
const { emit, SYSTEM_ACTOR } = require('../services/auditService');
const { broadcastListing } = require('../services/whatsappService');
const { VALID_CONDITIONS } = require('../config/listingOptions');
const { isHttpUrl } = require('../utils/safeUrl');
const { checkListing } = require('../services/moderationService');
const inputLimits = require('../config/inputLimits');
const { initiateBoostPayment, initiateListingPayment, initiateStorePlanPayment, BOOST_PRICES, LISTING_PRICES, STORE_PLANS } = require('../services/paymentService');
const { ACCEPTANCE_TYPES } = require('../config/termsVersions');
const {
  validateAcceptanceToken,
  recordAcceptance,
} = require('../services/termsAcceptanceService');
const TermsAcceptance = require('../models/TermsAcceptance');

// Initiate a boost payment (existing listing)
exports.initiateBoost = async (req, res, next) => {
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
    let response;
    let amount;
    try {
      // Payment-start failure must not leak IntaSend internals to the client;
      // a fixed, actionable message is returned instead.
      ({ response, amount } = await initiateBoostPayment({ phoneNumber, boostType, apiRef }));
    } catch (err) {
      // IntaSend SDK rejects with a raw unparsed Buffer/string on HTTP errors
      // — no stable type/code field — so it is not classified or logged here.
      return res.status(503).json({
        error: 'Payment could not be started — check your M-Pesa balance and phone number, then try again.',
        requestId: req.id,
      });
    }

    const invoiceId = response?.invoice?.invoice_id || response?.id || null;

    await Payment.create({
      type: 'boost',
      listingId,
      phoneNumber,
      amount,
      boostType,
      expectedAmount: BOOST_PRICES[boostType],
      invoiceId,
      status: 'pending',
    });

    res.json({ success: true, message: 'STK push sent. Check your phone.', invoiceId, amount });
  } catch (err) {
    logger.error('Boost payment error', { error: err.message });
    return next(err);
  }
};

// Initiate a listing payment (new listing — created only after payment confirms)
exports.initiateListing = async (req, res, next) => {
  try {
    const { phoneNumber, package: pkg, listingData, acceptance } = req.body;

    if (!LISTING_PRICES[pkg]) {
      return res.status(400).json({ success: false, error: 'Invalid listing package' });
    }
    if (!listingData || typeof listingData !== 'object') {
      return res.status(400).json({ success: false, error: 'Missing listing details' });
    }

    const acceptValidation = validateAcceptanceToken(acceptance, ACCEPTANCE_TYPES.LISTING_PUBLICATION);
    if (!acceptValidation.valid) {
      return res.status(400).json({
        success: false,
        error: `Terms acceptance required: ${acceptValidation.error}`,
      });
    }

    // Validate every field the Listing model requires BEFORE starting the STK push —
    // once payment completes, the webhook creates the listing from this data, and a
    // failed create at that point would mean the user paid but got nothing.
    const errors = [];
    if (typeof listingData.title !== 'string' || !listingData.title.trim()) errors.push('title');
    if (typeof listingData.category !== 'string' || !listingData.category.trim()) errors.push('category');
    if (!VALID_CONDITIONS.includes(listingData.condition)) errors.push('condition');
    // Image entries are rendered into <img src> — reject non-http(s) schemes
    // (javascript:, data:, …) before the STK push so they are never stored.
    if (listingData.images !== undefined
      && (!Array.isArray(listingData.images) || !listingData.images.every(isHttpUrl))) errors.push('images');
    const price = Number(listingData.price);
    if (!Number.isFinite(price) || price < 0) errors.push('price');
    if (typeof listingData.description !== 'string' || !listingData.description.trim()) errors.push('description');
    if (typeof listingData.sellerName !== 'string' || !listingData.sellerName.trim()) errors.push('sellerName');
    if (typeof listingData.sellerWhatsapp !== 'string' || !listingData.sellerWhatsapp.trim()) errors.push('sellerWhatsapp');
    // Length caps: reject oversized free-text (and too many images) before the
    // STK push, since the webhook persists this payload verbatim.
    const listingCaps = inputLimits.listing;
    for (const [field, cap] of Object.entries(listingCaps)) {
      if (typeof cap !== 'number') continue;
      const value = listingData[field];
      if (typeof value === 'string' && value.trim().length > cap) errors.push(field);
    }
    if (Array.isArray(listingData.images) && listingData.images.length > listingCaps.images.maxItems) {
      errors.push('images');
    }
    if (errors.length > 0) {
      return res.status(400).json({ success: false, error: `Invalid or missing listing details: ${errors.join(', ')}` });
    }
    // store_id is not accepted at creation: a listing is always published
    // standalone and attached to a store afterwards via the owner endpoint.
    // Rejecting here (before any IntaSend call or Payment.create) means a caller
    // cannot link a listing to an unverified store at payment time.
    if (listingData.store_id !== undefined && listingData.store_id !== null && listingData.store_id !== '') {
      return res.status(400).json({
        success: false,
        error: 'store_id is not accepted here; attach the listing to a store after it is published',
      });
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
    let response;
    let amount;
    try {
      // Payment-start failure must not leak IntaSend internals to the client;
      // a fixed, actionable message is returned instead.
      ({ response, amount } = await initiateListingPayment({ phoneNumber, package: pkg, apiRef }));
    } catch (err) {
      // IntaSend SDK rejects with a raw unparsed Buffer/string on HTTP errors
      // — no stable type/code field — so it is not classified or logged here.
      return res.status(503).json({
        error: 'Payment could not be started — check your M-Pesa balance and phone number, then try again.',
        requestId: req.id,
      });
    }

    const invoiceId = response?.invoice?.invoice_id || response?.id || null;

    const ip = req.ip;
    const userAgent = req.get('user-agent') || '';

    const acceptanceRec = await recordAcceptance({
      acceptanceType: ACCEPTANCE_TYPES.LISTING_PUBLICATION,
      versions: acceptValidation.versions,
      action: `PAY_AND_PUBLISH:${pkg}`,
      phone: phoneNumber,
      whatsapp: listingData.sellerWhatsapp,
      ownerTokenHash,
      ip,
      userAgent,
      paymentInvoiceId: invoiceId,
      fee: {
        amount,
        currency: 'KES',
        label: `Listing package: ${pkg}`,
      },
      storeId: listingData && listingData.store_id ? listingData.store_id : null,
      metadata: {
        listingTitle: listingData.title || null,
        listingCategory: listingData.category || null,
      },
    });

    await Payment.create({
      type: 'listing',
      phoneNumber,
      amount,
      package: pkg,
      expectedAmount: LISTING_PRICES[pkg].amount,
      listingData,
      ownerTokenHash,
      invoiceId,
      termsAcceptanceId: acceptanceRec._id,
      status: 'pending',
    });

    res.json({ success: true, message: 'STK push sent. Check your phone.', invoiceId, amount, ownerToken: rawOwnerToken });
  } catch (err) {
    logger.error('Listing payment error', { error: err.message });
    return next(err);
  }
};

// Initiate a store plan payment (new store — created only after payment confirms)
exports.initiateStorePlan = async (req, res, next) => {
  try {
    const { phoneNumber, storePlan, storeData, acceptance } = req.body;

    if (!STORE_PLANS[storePlan]) {
      return res.status(400).json({ success: false, error: 'Invalid store plan' });
    }
    if (!storeData || typeof storeData !== 'object') {
      return res.status(400).json({ success: false, error: 'Missing store details' });
    }

    const acceptValidation = validateAcceptanceToken(acceptance, ACCEPTANCE_TYPES.STORE_CREATION);
    if (!acceptValidation.valid) {
      return res.status(400).json({
        success: false,
        error: `Terms acceptance required: ${acceptValidation.error}`,
      });
    }

    // Validate required store fields
    const errors = [];
    if (typeof storeData.name !== 'string' || !storeData.name.trim()) errors.push('name');
    if (typeof storeData.category !== 'string' || !storeData.category.trim()) errors.push('category');
    if (typeof storeData.phone !== 'string' || !storeData.phone.trim()) errors.push('phone');
    if (typeof storeData.whatsapp !== 'string' || !storeData.whatsapp.trim()) errors.push('whatsapp');
    // Length caps: reject oversized free-text and oversized arrays before the
    // STK push, since the webhook persists this payload verbatim.
    const storeCaps = inputLimits.store;
    for (const [field, cap] of Object.entries(storeCaps)) {
      if (typeof cap !== 'number') continue;
      const value = storeData[field];
      if (typeof value === 'string' && value.trim().length > cap) errors.push(field);
    }
    if (Array.isArray(storeData.subcategories)) {
      if (storeData.subcategories.length > storeCaps.subcategories.maxItems
        || storeData.subcategories.some((item) => typeof item === 'string' && item.trim().length > storeCaps.subcategories.item)) {
        errors.push('subcategories');
      }
    }
    if (Array.isArray(storeData.payment_methods)) {
      if (storeData.payment_methods.length > storeCaps.payment_methods.maxItems
        || storeData.payment_methods.some((item) => typeof item === 'string' && item.trim().length > storeCaps.payment_methods.item)) {
        errors.push('payment_methods');
      }
    }
    if (errors.length > 0) {
      return res.status(400).json({ success: false, error: `Invalid or missing store details: ${errors.join(', ')}` });
    }

    // Generate store owner token
    const rawOwnerToken = crypto.randomBytes(24).toString('hex');
    const ownerTokenHash = crypto.createHash('sha256').update(rawOwnerToken).digest('hex');

    // Generate slug
    let base = storeData.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    if (!base) base = 'store';
    const Store = require('../models/Store');
    let slug = base;
    let counter = 2;
    while (await Store.findOne({ slug })) {
      slug = `${base}-${counter}`;
      counter++;
    }

    const apiRef = `store_${Date.now()}`;
    let response;
    let amount;
    try {
      // Payment-start failure must not leak IntaSend internals to the client;
      // a fixed, actionable message is returned instead.
      ({ response, amount } = await initiateStorePlanPayment({ phoneNumber, storePlan, apiRef }));
    } catch (err) {
      // IntaSend SDK rejects with a raw unparsed Buffer/string on HTTP errors
      // — no stable type/code field — so it is not classified or logged here.
      return res.status(503).json({
        error: 'Payment could not be started — check your M-Pesa balance and phone number, then try again.',
        requestId: req.id,
      });
    }

    const invoiceId = response?.invoice?.invoice_id || response?.id || null;

    const ip = req.ip;
    const userAgent = req.get('user-agent') || '';

    const acceptanceRec = await recordAcceptance({
      acceptanceType: ACCEPTANCE_TYPES.STORE_CREATION,
      versions: acceptValidation.versions,
      action: `PAY_AND_CREATE_STORE:${storePlan}`,
      phone: phoneNumber,
      whatsapp: storeData.whatsapp,
      ownerTokenHash,
      ip,
      userAgent,
      paymentInvoiceId: invoiceId,
      fee: {
        amount,
        currency: 'KES',
        label: `Store plan: ${storePlan}`,
      },
      metadata: {
        storeName: storeData.name || null,
        storeCategory: storeData.category || null,
      },
    });

    await Payment.create({
      type: 'store',
      phoneNumber,
      amount,
      storePlan,
      expectedAmount: STORE_PLANS[storePlan].amount,
      storeData: { ...storeData, slug },
      ownerTokenHash,
      invoiceId,
      termsAcceptanceId: acceptanceRec._id,
      status: 'pending',
    });

    res.json({ success: true, message: 'STK push sent. Check your phone.', invoiceId, amount, ownerToken: rawOwnerToken });
  } catch (err) {
    logger.error('Store plan payment error', { error: err.message });
    return next(err);
  }
};

// Create the resource a completed payment should produce, with paymentId
// attached so a duplicate delivery collides on the unique sparse index
// (E11000) and re-reads the first attempt's document rather than creating a
// second. Shared by the webhook and the admin replay endpoint so both run the
// identical payload mapping. This function does ONLY creation + the E11000
// re-read; the caller owns every other side effect (payment back-reference,
// audit emit, broadcast, logging).
async function createResourceForPayment(payment) {
  if (payment.type === 'listing') {
    const pricing = LISTING_PRICES[payment.package];
    const moderation = checkListing(payment.listingData || {});
    let listing;
    try {
      listing = await Listing.create({
        paymentId: payment._id,
        ...payment.listingData,
        package: payment.package,
        expiresAt: new Date(Date.now() + pricing.durationMs),
        moderationStatus: moderation.approved ? 'approved' : 'flagged',
        ownerTokenHash: payment.ownerTokenHash,
      });
    } catch (err) {
      if (err && err.code === 11000 && err.keyPattern?.paymentId) {
        listing = await Listing.findOne({ paymentId: payment._id });
      } else {
        throw err;
      }
    }
    return { type: 'listing', doc: listing };
  }

  if (payment.type === 'store') {
    const Store = require('../models/Store');
    const pricing = STORE_PLANS[payment.storePlan];
    let store;
    try {
      store = await Store.create({
        paymentId: payment._id,
        name: payment.storeData.name,
        slug: payment.storeData.slug,
        description: payment.storeData.description || '',
        category: payment.storeData.category,
        subcategories: payment.storeData.subcategories || [],
        phone: payment.storeData.phone || '',
        whatsapp: payment.storeData.whatsapp || '',
        email: payment.storeData.email || '',
        campus: payment.storeData.campus || 'Egerton University',
        location: payment.storeData.location || '',
        pickup_location: payment.storeData.pickup_location || '',
        ownerTokenHash: payment.ownerTokenHash,
        plan: payment.storePlan,
        plan_price: pricing.amount,
        plan_duration: pricing.durationMs,
        listing_limit: pricing.listingLimit,
        started_at: new Date(),
        expires_at: new Date(Date.now() + pricing.durationMs),
        status: 'active',
      });
    } catch (err) {
      if (err && err.code === 11000 && err.keyPattern?.paymentId) {
        store = await Store.findOne({ paymentId: payment._id });
      } else {
        throw err;
      }
    }
    return { type: 'store', doc: store };
  }

  throw new Error(`createResourceForPayment: unsupported payment type ${payment.type}`);
}

exports.createResourceForPayment = createResourceForPayment;

// Webhook: IntaSend calls this when payment status changes
exports.handleWebhook = async (req, res, next) => {
  try {
    const receivedChallenge = req.body.challenge;
    const expectedChallenge = process.env.INTASEND_WEBHOOK_CHALLENGE;
    // Fail closed when the expected challenge is unset: an absent body `challenge`
    // would otherwise compare equal to an absent env value (`undefined !==
    // undefined` is false) and accept a forged webhook. Read at call time so the
    // check reflects the current deployment environment rather than module load.
    if (!expectedChallenge || receivedChallenge !== expectedChallenge) {
      // Whitelist only debug-useful fields — the raw body contains the webhook
      // challenge secret and payer phone numbers (audit §4.3).
      logger.error('Webhook challenge mismatch', {
        invoice_id: req.body.invoice_id,
        state: req.body.state,
        api_ref: req.body.api_ref,
        // body intentionally omitted — contains PII and the webhook challenge secret
      });
      return res.status(401).json({ success: false, error: 'Invalid webhook challenge' });
    }

    const { invoice_id, state } = req.body;

    // Mongoose 9 strips `undefined` from query filters, so a valid-challenge
    // webhook with no invoice_id would collapse the claim filter below to
    // `{ status: { $ne: 'completed' } }` and claim an arbitrary pending payment.
    // Fail closed before any lookup.
    if (!invoice_id) {
      logger.error('Webhook missing invoice_id', { state });
      emit({
        actor: SYSTEM_ACTOR,
        action: 'webhook.missing_invoice_id',
        resource: 'payment',
        result: 'failure',
        metadata: { state },
      });
      return res.status(400).json({ success: false, error: 'invoice_id is required' });
    }

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

      // Server-side amount validation. Prefer the canonical price captured on
      // the Payment at initiation time (Payment.expectedAmount) so a price
      // change between initiation and completion never rejects a genuinely paid
      // record. Legacy payments predating that field have no value and fall
      // back to the live price table. Any drift must not provision a resource.
      const expectedAmount = payment.expectedAmount
        ?? LISTING_PRICES[payment.package]?.amount
        ?? STORE_PLANS[payment.storePlan]?.amount
        ?? BOOST_PRICES[payment.boostType];
      if (payment.amount !== expectedAmount) {
        logger.error(`Payment amount mismatch: expected ${expectedAmount}, stored ${payment.amount}, invoice ${invoice_id}`);
        emit({
          actor: SYSTEM_ACTOR,
          action: 'payment.amount_mismatch',
          resource: 'payment',
          resourceId: String(payment._id),
          result: 'failure',
          metadata: { type: payment.type, expectedAmount: expectedAmount ?? null, storedAmount: payment.amount ?? null },
        });
        return res.status(400).json({ success: false, error: 'Payment amount validation failed' });
      }

      if (payment.type === 'listing') {
        // Content moderation gate: flagged listings are created (payment already
        // completed) but hidden from public views and NOT broadcast.
        const moderation = checkListing(payment.listingData || {});
        const { doc: listing } = await createResourceForPayment(payment);
        // Record which listing this payment produced (Payment.listingId is
        // designed to stay absent until the listing payment completes) so the
        // status endpoint can tell the payer which listing they now own.
        payment.listingId = listing._id;

        // Back-fill the created listing's ID onto the pre-payment acceptance record
        // so the acceptance is permanently linked to the specific published listing.
        if (payment.termsAcceptanceId) {
          await TermsAcceptance.findByIdAndUpdate(
            payment.termsAcceptanceId,
            { listingId: listing._id },
          ).catch((err) => logger.warn('Failed to link acceptance to listing', {
            acceptanceId: String(payment.termsAcceptanceId),
            listingId: String(listing._id),
            error: err.message,
          }));
        }

        await payment.save();
        emit({
          actor: SYSTEM_ACTOR,
          action: 'payment.completed',
          resource: 'payment',
          resourceId: String(payment._id),
          result: 'success',
          metadata: { type: 'listing' },
        });
        if (!moderation.approved) {
          logger.warn('Listing flagged by moderation', { listingId: String(listing._id), flaggedBy: moderation.flaggedBy });
          return res.status(200).json({ success: true });
        }
        // Record that the paid broadcast was dispatched BEFORE returning, so the
        // listing record stays truthful even though the Whapi call below is
        // fire-and-forget (failures are logged, never retried).
        listing.broadcastSent = true;
        await listing.save();
        broadcastListing(listing).catch(err => {
          logger.warn('WhatsApp broadcast skipped (Whapi unavailable)', { error: err.message });
          emit({
            actor: SYSTEM_ACTOR,
            action: 'webhook.broadcast_skipped',
            resource: 'listing',
            resourceId: String(listing._id),
            result: 'failure',
          });
        });
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
            // Customer paid for an extra WhatsApp round: the flag moves this
            // listing to the top of listings queries AND the listing is
            // re-broadcast (same save-then-fire convention as the listing branch).
            listing.priorityBroadcast = true;
            listing.broadcastSent = true;
          }
          await listing.save();
          if (payment.boostType === 'priority_broadcast') {
            broadcastListing(listing).catch(err =>
              logger.warn('Priority broadcast skipped (Whapi unavailable)', { error: err.message })
            );
          }
        }
      } else if (payment.type === 'store') {
        const { doc: store } = await createResourceForPayment(payment);

        payment.storeId = store._id;

        if (payment.termsAcceptanceId) {
          await TermsAcceptance.findByIdAndUpdate(
            payment.termsAcceptanceId,
            { storeId: store._id },
          ).catch((err) => logger.warn('Failed to link acceptance to store', {
            acceptanceId: String(payment.termsAcceptanceId),
            storeId: String(store._id),
            error: err.message,
          }));
        }

        await payment.save();
        emit({
          actor: SYSTEM_ACTOR,
          action: 'payment.completed',
          resource: 'payment',
          resourceId: String(payment._id),
          result: 'success',
          metadata: { type: 'store' },
        });
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
    return next(err);
  }
};

// Status check: the frontend polls this after initiating a listing payment to
// learn (a) whether the STK push completed and (b) the id of the listing the
// webhook created — the point at which the client can re-key its saved owner
// token from invoiceId to the actual listing id. Gated by knowledge of the
// invoiceId issued at initiate time; returns no sensitive material.
exports.checkPaymentStatus = async (req, res, next) => {
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
      storeId: payment.storeId || null,
    });
  } catch (err) {
    return next(err);
  }
};