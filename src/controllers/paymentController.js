const Listing = require('../models/Listing');
const Payment = require('../models/Payment');
const { broadcastListing } = require('../services/whatsappService');
const { initiateBoostPayment, initiateListingPayment, BOOST_PRICES, LISTING_PRICES } = require('../services/paymentService');

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
    console.error('Boost payment error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
};

// Initiate a listing payment (new listing — created only after payment confirms)
exports.initiateListing = async (req, res) => {
  try {
    const { phoneNumber, package: pkg, listingData } = req.body;

    if (!LISTING_PRICES[pkg]) {
      return res.status(400).json({ success: false, error: 'Invalid listing package' });
    }
    if (!listingData || !listingData.title || !listingData.sellerWhatsapp) {
      return res.status(400).json({ success: false, error: 'Missing listing details' });
    }

    const apiRef = `listing_${Date.now()}`;
    const { response, amount } = await initiateListingPayment({ phoneNumber, package: pkg, apiRef });

    const invoiceId = response?.invoice?.invoice_id || response?.id || null;

    await Payment.create({
      type: 'listing',
      phoneNumber,
      amount,
      package: pkg,
      listingData,
      invoiceId,
      status: 'pending',
    });

    res.json({ success: true, message: 'STK push sent. Check your phone.', invoiceId, amount });
  } catch (err) {
    console.error('Listing payment error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
};

// Webhook: IntaSend calls this when payment status changes
exports.handleWebhook = async (req, res) => {
  try {
    const receivedChallenge = req.body.challenge;
    if (receivedChallenge !== process.env.INTASEND_WEBHOOK_CHALLENGE) {
      console.error('Webhook challenge mismatch. Full payload for debugging:', JSON.stringify(req.body));
      return res.status(401).json({ success: false, error: 'Invalid webhook challenge' });
    }

    const { invoice_id, state } = req.body;

    const payment = await Payment.findOne({ invoiceId: invoice_id });
    if (!payment) {
      return res.status(404).json({ success: false, error: 'Payment record not found' });
    }

    if (state === 'COMPLETE') {
      payment.status = 'completed';
      await payment.save();

      if (payment.type === 'listing') {
        // Create the listing now that payment has confirmed
        const pricing = LISTING_PRICES[payment.package];
        const listing = await Listing.create({
          ...payment.listingData,
          package: payment.package,
          expiresAt: new Date(Date.now() + pricing.durationMs),
        });
        broadcastListing(listing).catch(err =>
          console.error('Broadcast failed:', err.message)
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
      payment.status = 'failed';
      await payment.save();
    }

    res.status(200).json({ success: true });
  } catch (err) {
    console.error('Webhook error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
};