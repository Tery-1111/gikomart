const TermsAcceptance = require('../models/TermsAcceptance');
const logger = require('../config/logger');
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

exports.recordContactAcceptance = async (req, res) => {
  try {
    const {
      acceptance,
      listingId,
      sellerWhatsapp,
      listingTitle,
      buyerPhone,
      buyerWhatsapp,
    } = req.body || {};

    if (!listingId) {
      return res.status(400).json({ success: false, error: 'listingId required' });
    }
    if (!sellerWhatsapp) {
      return res.status(400).json({ success: false, error: 'sellerWhatsapp required' });
    }

    const validation = validateAcceptanceToken(acceptance, ACCEPTANCE_TYPES.BUYER_CONTACT);
    if (!validation.valid) {
      return res.status(400).json({
        success: false,
        error: validation.error,
      });
    }

    const rec = await recordAcceptance({
      acceptanceType: ACCEPTANCE_TYPES.BUYER_CONTACT,
      versions: validation.versions,
      action: 'CONTINUE_AND_CONTACT_SELLER',
      phone: buyerPhone || null,
      whatsapp: buyerWhatsapp || null,
      ip: req.headers['x-forwarded-for'] || req.socket?.remoteAddress || null,
      userAgent: req.get('user-agent') || '',
      listingId,
      sellerContactTarget: {
        sellerWhatsapp,
        listingTitle: listingTitle || null,
      },
    });

    logger.info('Buyer contact acceptance recorded', {
      acceptanceId: String(rec._id),
      listingId: String(listingId),
    });

    res.json({
      success: true,
      acceptanceId: String(rec._id),
      message: 'Buyer terms acceptance recorded. Contact may proceed.',
    });
  } catch (err) {
    logger.error('Buyer contact acceptance failure', { error: err.message });
    res.status(500).json({ success: false, error: err.message });
  }
};

module.exports = exports;
