const crypto = require('crypto');
const TermsAcceptance = require('../models/TermsAcceptance');
const { TERMS_VERSIONS, ACCEPTANCE_TYPES } = require('../config/termsVersions');

function sha256(val) {
  if (!val) return null;
  return crypto.createHash('sha256').update(String(val)).digest('hex');
}

function buildTermsVersionsForType(acceptanceType) {
  const base = {
    gikomartTermsOfService: TERMS_VERSIONS.GIKOMART_TERMS_OF_SERVICE,
  };
  switch (acceptanceType) {
    case ACCEPTANCE_TYPES.STORE_CREATION:
      return { ...base, storeOwnerTerms: TERMS_VERSIONS.STORE_OWNER_TERMS };
    case ACCEPTANCE_TYPES.LISTING_PUBLICATION:
      return { ...base, sellerTerms: TERMS_VERSIONS.SELLER_TERMS };
    case ACCEPTANCE_TYPES.BUYER_CONTACT:
      return { ...base, buyerTerms: TERMS_VERSIONS.BUYER_TERMS };
    default:
      return base;
  }
}

function validateAcceptanceToken(acceptance, acceptanceType) {
  if (!acceptance || typeof acceptance !== 'object') {
    return { valid: false, error: 'Acceptance payload required' };
  }
  const expected = buildTermsVersionsForType(acceptanceType);
  if (acceptance.gikomartTermsVersion !== expected.gikomartTermsOfService) {
    return { valid: false, error: `GikoMart Terms version mismatch. Expected ${expected.gikomartTermsOfService}` };
  }
  if (acceptanceType === ACCEPTANCE_TYPES.STORE_CREATION) {
    if (acceptance.storeOwnerTermsVersion !== expected.storeOwnerTerms) {
      return { valid: false, error: `Store Owner Terms version mismatch. Expected ${expected.storeOwnerTerms}` };
    }
  }
  if (acceptanceType === ACCEPTANCE_TYPES.LISTING_PUBLICATION) {
    if (acceptance.sellerTermsVersion !== expected.sellerTerms) {
      return { valid: false, error: `Seller Terms version mismatch. Expected ${expected.sellerTerms}` };
    }
  }
  if (acceptanceType === ACCEPTANCE_TYPES.BUYER_CONTACT) {
    if (acceptance.buyerTermsVersion !== expected.buyerTerms) {
      return { valid: false, error: `Buyer Terms version mismatch. Expected ${expected.buyerTerms}` };
    }
  }
  if (acceptance.accepted !== true) {
    return { valid: false, error: 'Explicit acceptance (accepted:true) required' };
  }
  return { valid: true, versions: expected };
}

async function recordAcceptance({
  acceptanceType,
  versions,
  action,
  phone = null,
  whatsapp = null,
  ownerTokenHash = null,
  ip = null,
  userAgent = null,
  storeId = null,
  listingId = null,
  paymentInvoiceId = null,
  fee = null,
  sellerContactTarget = null,
  metadata = null,
}) {
  return TermsAcceptance.create({
    acceptanceType,
    termsVersions: versions,
    action,
    actor: {
      phoneHash: sha256(phone),
      whatsappHash: sha256(whatsapp),
      ownerTokenHash,
      ip,
      userAgent,
    },
    storeId: storeId || undefined,
    listingId: listingId || undefined,
    paymentInvoiceId: paymentInvoiceId || undefined,
    fee: fee
      ? {
          amount: fee.amount ?? null,
          currency: fee.currency || 'KES',
          label: fee.label || null,
        }
      : undefined,
    sellerContactTarget: sellerContactTarget
      ? {
          sellerWhatsappHash: sha256(sellerContactTarget.sellerWhatsapp),
          listingTitle: sellerContactTarget.listingTitle || undefined,
        }
      : undefined,
    metadata: metadata || undefined,
  });
}

module.exports = {
  buildTermsVersionsForType,
  validateAcceptanceToken,
  recordAcceptance,
  sha256,
};
