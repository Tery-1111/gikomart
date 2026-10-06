const mongoose = require('mongoose');
const logger = require('../config/logger');
const Listing = require('../models/Listing');
const TermsAcceptance = require('../models/TermsAcceptance');
const { ACCEPTANCE_TYPES, TERMS_VERSIONS } = require('../config/termsVersions');
const {
  validateAcceptanceToken,
  recordAcceptance,
} = require('../services/termsAcceptanceService');

exports.getVersions = async (_req, res) => {
  res.json({
    success: true,
    versions: TERMS_VERSIONS,
    acceptanceTypes: ACCEPTANCE_TYPES,
    docs: {
      'GikoMart Terms of Service': '/legal/terms-of-service.html',
      'Store Owner Terms & Conditions': '/legal/store-owner-terms.html',
      'Seller Terms & Conditions': '/legal/seller-terms.html',
      'Buyer Terms & Conditions': '/legal/buyer-terms.html',
    },
  });
};

// This is the single sanctioned release point for seller contact data. Do not
// return sellerWhatsapp anywhere else.
exports.recordContactAcceptance = async (req, res, next) => {
  try {
    const {
      acceptance,
      listingId,
      listingTitle,
      buyerPhone,
      buyerWhatsapp,
    } = req.body || {};

    // 1. A listing id is required to know which stored contact to release.
    if (!listingId) {
      return res.status(400).json({ success: false, error: 'listingId required' });
    }

    // 2. Validate the acceptance token BEFORE any database lookup, so a caller
    //    cannot probe listing existence without first proving acceptance.
    const validation = validateAcceptanceToken(acceptance, ACCEPTANCE_TYPES.BUYER_CONTACT);
    if (!validation.valid) {
      return res.status(400).json({
        success: false,
        error: validation.error,
      });
    }

    // 3. Reject a malformed id without touching the database.
    if (!mongoose.Types.ObjectId.isValid(listingId)) {
      return res.status(404).json({ success: false, error: 'Listing not found' });
    }

    // 4. Only a live, approved listing can release contact — the same visibility
    //    filter the public listing detail endpoint uses.
    const listing = await Listing.findOne({
      _id: listingId,
      status: 'active',
      moderationStatus: 'approved',
    });
    if (!listing) {
      return res.status(404).json({ success: false, error: 'Listing not found' });
    }

    // 5. The stored contact is the only source of truth; if it is missing there
    //    is nothing to release.
    const sellerWhatsapp = listing.sellerWhatsapp;
    if (!sellerWhatsapp) {
      return res.status(400).json({ success: false, error: 'Seller contact unavailable' });
    }

    // 5b. Contact-release caps: one listing must not be milked for its seller
    //    number beyond 30 releases per rolling hour, and the whole contact
    //    flow is capped at 1500 releases per rolling hour globally. Keyed on
    //    the BUYER_CONTACT acceptance records (created by this endpoint), not
    //    on IP — IP rotation does not bypass these. Checked before the
    //    acceptance record is written and the number is returned.
    const CONTACT_CAP_429 = { success: false, error: 'This contact is temporarily unavailable. Please try again later.' };
    const releaseWindowStart = new Date(Date.now() - 60 * 60 * 1000);
    const [listingReleases, globalReleases] = await Promise.all([
      TermsAcceptance.countDocuments({
        listingId,
        acceptanceType: ACCEPTANCE_TYPES.BUYER_CONTACT,
        timestamp: { $gte: releaseWindowStart },
      }),
      TermsAcceptance.countDocuments({
        acceptanceType: ACCEPTANCE_TYPES.BUYER_CONTACT,
        timestamp: { $gte: releaseWindowStart },
      }),
    ]);
    if (listingReleases >= 30 || globalReleases >= 1500) {
      logger.warn('Contact release cap reached', { listingId: String(listingId), listingReleases, globalReleases });
      return res.status(429).json(CONTACT_CAP_429);
    }

    // 6. Record the acceptance, hashing the contact actually released (from the
    //    listing, never the request body). Await fully before responding.
    const rec = await recordAcceptance({
      acceptanceType: ACCEPTANCE_TYPES.BUYER_CONTACT,
      versions: validation.versions,
      action: 'CONTINUE_AND_CONTACT_SELLER',
      phone: buyerPhone || null,
      whatsapp: buyerWhatsapp || null,
      ip: req.ip,
      userAgent: req.get('user-agent') || '',
      listingId,
      sellerContactTarget: {
        sellerWhatsapp,
        listingTitle: listing.title || listingTitle || null,
      },
    });

    logger.info('Buyer contact acceptance recorded', {
      acceptanceId: String(rec._id),
      listingId: String(listingId),
    });

    // 7. Release the contact with no-store so it is never cached.
    res.set('Cache-Control', 'no-store');
    res.json({
      success: true,
      acceptanceId: String(rec._id),
      sellerWhatsapp,
    });
  } catch (err) {
    logger.error('Buyer contact acceptance failure', { error: err.message });
    return next(err);
  }
};

module.exports = exports;
