const cron = require('node-cron');
const Listing = require('../models/Listing');
const Store = require('../models/Store');
const cloudinary = require('../config/cloudinary');
const logger = require('../config/logger');

// Extract the Cloudinary public_id from a stored secure_url
// e.g. https://res.cloudinary.com/xxx/image/upload/v123/gikomart/abc.webp -> gikomart/abc
function extractPublicId(url) {
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
  });
  logger.info('Cleanup scheduler started (every 30 min) — listings + store expiry');
}

module.exports = { startCleanupScheduler, deleteExpiredListings, expireStores };