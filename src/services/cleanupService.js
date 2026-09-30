const cron = require('node-cron');
const Listing = require('../models/Listing');
const Store = require('../models/Store');
const TermsAcceptance = require('../models/TermsAcceptance');
const cloudinary = require('../config/cloudinary');
const logger = require('../config/logger');

// Extract the Cloudinary public_id from a stored secure_url
// e.g. https://res.cloudinary.com/xxx/image/upload/v123/gikomart/abc.webp -> gikomart/abc
function extractPublicId(url) {
  // eslint-disable-next-line security/detect-unsafe-regex -- double-anchored, bounded-length URLs; worst case is quadratic over ~100 chars, not ReDoS
  const match = url.match(/\/upload\/(?:v\d+\/)?(.+)\.\w+$/);
  return match ? match[1] : null;
}

async function deleteExpiredListings() {
  try {
    const expired = await Listing.find({ expiresAt: { $lte: new Date() } });

    if (!expired.length) return;

    for (const listing of expired) {
      if (listing.images && listing.images.length > 0) {
        for (const imageUrl of listing.images) {
          const publicId = extractPublicId(imageUrl);
          if (publicId) {
            try {
              await cloudinary.uploader.destroy(publicId);
            } catch (err) {
              logger.warn('Failed to delete Cloudinary image', { publicId, error: err.message });
            }
          }
        }
      }
      await Listing.deleteOne({ _id: listing._id });
    }

    logger.info('Cleanup: deleted expired listings', { count: expired.length });
  } catch (err) {
    logger.error('Cleanup job error', { error: err.message });
  }
}

// 30-day PII retention: strip contact/location fields from stores expired
// longer than 30 days. The store record itself is kept; only PII is nulled.
async function stripExpiredStoreContacts() {
  try {
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const expired = await Store.find({
      expires_at: { $lte: cutoff },
      $or: [
        { phone: { $nin: [null, ''] } },
        { whatsapp: { $nin: [null, ''] } },
        { email: { $nin: [null, ''] } },
        { location: { $nin: [null, ''] } },
        { pickup_location: { $nin: [null, ''] } },
      ],
    });

    if (!expired.length) return;

    for (const store of expired) {
      store.phone = null;
      store.whatsapp = null;
      store.email = null;
      store.location = null;
      store.pickup_location = null;
      await store.save();
    }

    logger.info('Retention: stripped store contact PII (expired >30d)', { count: expired.length });
  } catch (err) {
    logger.error('Store contact retention job error', { error: err.message });
  }
}

// 30-day PII retention: null the actor IP, phoneHash, and userAgent on
// acceptance records older than 30 days. phoneHash is brute-forceable over
// the Kenyan phone space (pseudonymous, not anonymous); userAgent is a weak
// fingerprint. The record itself is kept; only these fields are nulled.
async function stripOldAcceptancePII() {
  try {
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const old = await TermsAcceptance.find({
      timestamp: { $lte: cutoff },
      'actor.ip': { $ne: null },
    });

    if (!old.length) return;

    for (const record of old) {
      record.actor.ip = null;
      record.actor.phoneHash = null;
      record.actor.userAgent = null;
      await record.save();
    }

    logger.info('Retention: stripped TermsAcceptance actor PII (>30d)', { count: old.length });
  } catch (err) {
    logger.error('Acceptance PII retention job error', { error: err.message });
  }
}

async function expireStores() {
  try {
    const expired = await Store.find({
      expires_at: { $lte: new Date() },
      status: 'active',
    });

    if (!expired.length) return;

    for (const store of expired) {
      store.status = 'expired';
      await store.save();
    }

    logger.info('Cleanup: expired stores', { count: expired.length });
  } catch (err) {
    logger.error('Store expiry job error', { error: err.message });
  }
}

function startCleanupScheduler() {
  // Runs every 30 minutes
  cron.schedule('*/30 * * * *', async () => {
    await deleteExpiredListings();
    await expireStores();
    await stripExpiredStoreContacts();
    await stripOldAcceptancePII();
  });
  logger.info('Cleanup scheduler started (every 30 min) — listings + store expiry + PII retention');
}

module.exports = {
  startCleanupScheduler,
  deleteExpiredListings,
  expireStores,
  stripExpiredStoreContacts,
  stripOldAcceptancePII,
};