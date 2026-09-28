const TERMS_VERSIONS = Object.freeze({
  GIKOMART_TERMS_OF_SERVICE: '1.0.0',
  STORE_OWNER_TERMS: '1.0.0',
  SELLER_TERMS: '1.0.0',
  BUYER_TERMS: '1.0.0',
});

const ACCEPTANCE_TYPES = Object.freeze({
  STORE_CREATION: 'STORE_CREATION',
  LISTING_PUBLICATION: 'LISTING_PUBLICATION',
  BUYER_CONTACT: 'BUYER_CONTACT',
});

const TERMS_DOC_SLUGS = Object.freeze({
  'GikoMart Terms of Service': 'terms-of-service',
  'Store Owner Terms & Conditions': 'store-owner-terms',
  'Seller Terms & Conditions': 'seller-terms',
  'Buyer Terms & Conditions': 'buyer-terms',
});

module.exports = {
  TERMS_VERSIONS,
  ACCEPTANCE_TYPES,
  TERMS_DOC_SLUGS,
};
