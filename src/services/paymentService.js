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

module.exports = { initiateBoostPayment, initiateListingPayment, checkPaymentStatus, BOOST_PRICES, LISTING_PRICES };