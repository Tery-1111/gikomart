const IntaSend = require('intasend-node');
require('dotenv').config();

const intasend = new IntaSend(
  process.env.INTASEND_PUBLISHABLE_KEY,
  process.env.INTASEND_SECRET_KEY,
  process.env.INTASEND_TEST_MODE === 'true'
);

const BOOST_PRICES = {
  featured: 50,
  rush: 80,
  priority_broadcast: 30,
};

const LISTING_PRICES = {
  quick: { amount: 30, durationMs: 24 * 60 * 60 * 1000 },
  standard: { amount: 50, durationMs: 7 * 24 * 60 * 60 * 1000 },
  premium: { amount: 150, durationMs: 30 * 24 * 60 * 60 * 1000 },
};

const STORE_PLANS = {
  starter_weekly:   { amount: 150, durationMs: 7 * 24 * 60 * 60 * 1000,   listingLimit: 5  },
  // standard_weekly removed (audit Fix 6): same price/limit as standard_monthly
  // but was never sellable — absent from the frontend STORE_PLANS list, so a
  // crafted request was the only way to reach it.
  standard_monthly: { amount: 200, durationMs: 30 * 24 * 60 * 60 * 1000,  listingLimit: 10 },
  pro_monthly:      { amount: 300, durationMs: 30 * 24 * 60 * 60 * 1000,  listingLimit: 15 },
};

// Normalize any Kenyan number format (+254 7XX XXX XXX, 07XXXXXXXX, etc.) to 2547XXXXXXXX
function normalizePhone(phone) {
  let digits = phone.replace(/\D/g, '');
  if (digits.startsWith('0')) digits = '254' + digits.slice(1);
  if (digits.startsWith('7') || digits.startsWith('1')) digits = '254' + digits;
  return digits;
}

async function initiateBoostPayment({ phoneNumber, boostType, apiRef }) {
  const amount = BOOST_PRICES[boostType];
  if (!amount) throw new Error('Invalid boost type');

  const collection = intasend.collection();
  const response = await collection.mpesaStkPush({
    first_name: 'GikoMart',
    last_name: 'Seller',
    email: 'seller@gikomart.com',
    host: process.env.APP_URL || 'https://gikomart.onrender.com',
    amount,
    phone_number: normalizePhone(phoneNumber),
    api_ref: apiRef,
  });

  return { response, amount };
}

async function initiateListingPayment({ phoneNumber, package: pkg, apiRef }) {
  const pricing = LISTING_PRICES[pkg];
  if (!pricing) throw new Error('Invalid listing package');

  const collection = intasend.collection();
  const response = await collection.mpesaStkPush({
    first_name: 'GikoMart',
    last_name: 'Seller',
    email: 'seller@gikomart.com',
    host: process.env.APP_URL || 'https://gikomart.onrender.com',
    amount: pricing.amount,
    phone_number: normalizePhone(phoneNumber),
    api_ref: apiRef,
  });

  return { response, amount: pricing.amount };
}

async function checkPaymentStatus(invoiceId) {
  const collection = intasend.collection();
  const response = await collection.status(invoiceId);
  return response;
}

async function initiateStorePlanPayment({ phoneNumber, storePlan, apiRef }) {
  const pricing = STORE_PLANS[storePlan];
  if (!pricing) throw new Error('Invalid store plan');

  const collection = intasend.collection();
  const response = await collection.mpesaStkPush({
    first_name: 'GikoMart',
    last_name: 'Store',
    email: 'store@gikomart.com',
    host: process.env.APP_URL || 'https://gikomart.onrender.com',
    amount: pricing.amount,
    phone_number: normalizePhone(phoneNumber),
    api_ref: apiRef,
  });

  return { response, amount: pricing.amount };
}

module.exports = { initiateBoostPayment, initiateListingPayment, initiateStorePlanPayment, checkPaymentStatus, BOOST_PRICES, LISTING_PRICES, STORE_PLANS };