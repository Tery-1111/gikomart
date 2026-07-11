const cron = require('node-cron');
const Listing = require('../models/Listing');
const cloudinary = require('../config/cloudinary');

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
              console.warn(`Failed to delete Cloudinary image ${publicId}:`, err.message);
            }
          }
        }
      }
      await Listing.deleteOne({ _id: listing._id });
    }

    console.log(`Cleanup: deleted ${expired.length} expired listing(s)`);
  } catch (err) {
    console.error('Cleanup job error:', err.message);
  }
}

function startCleanupScheduler() {
  // Runs every 30 minutes
  cron.schedule('*/30 * * * *', deleteExpiredListings);
  console.log('Listing cleanup scheduler started (every 30 min)');
}

module.exports = { startCleanupScheduler, deleteExpiredListings };