const IntaSend = require('intasend-node');
require('dotenv').config();

const intasend = new IntaSend(
  process.env.INTASEND_PUBLISHABLE_KEY,
  process.env.INTASEND_SECRET_KEY,
  process.env.INTASEND_TEST_MODE === 'true'
);

// Boost pricing (KSh)
const BOOST_PRICES = {
  featured: 50,
  rush: 80,
  priority_broadcast: 30,
};

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
    phone_number: phoneNumber,
    api_ref: apiRef,
  });

  return { response, amount };
}

async function checkPaymentStatus(invoiceId) {
  const collection = intasend.collection();
  const response = await collection.status(invoiceId);
  return response;
}

module.exports = { initiateBoostPayment, checkPaymentStatus, BOOST_PRICES };