const crypto = require('crypto');
const Store = require('../models/Store');
const Listing = require('../models/Listing');
const cloudinary = require('../config/cloudinary');
const logger = require('../config/logger');
const mongoose = require('mongoose');

// Constant-time comparison (same pattern as listingController.js)
function safeEqual(a, b) {
  const hashA = crypto.createHash('sha256').update(String(a)).digest();
  const hashB = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(hashA, hashB);
}

// Generate a URL-friendly slug from a store name. Handles collisions by
// appending -2, -3, etc. until a unique slug is found.
async function generateSlug(name) {
  let base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!base) base = 'store';

  let slug = base;
  let counter = 2;
  while (await Store.findOne({ slug })) {
    slug = `${base}-${counter}`;
    counter++;
  }
  return slug;
}

// Extract Cloudinary public_id from a URL (same pattern as listingController.js)
function extractPublicId(imageUrl) {
  const match = imageUrl.match(/\/upload\/(?:v\d+\/)?(.+)\.\w+$/);
  return match ? match[1] : null;
}

// Delete a Cloudinary image, logging but not throwing on failure
async function deleteCloudinaryImage(imageUrl) {
  if (!imageUrl) return;
  const publicId = extractPublicId(imageUrl);
  if (!publicId) return;
  try {
    await cloudinary.uploader.destroy(publicId);
  } catch (err) {
    logger.warn('Failed to delete Cloudinary image', { error: err.message, imageUrl });
  }
}

// ─── Public: Get store by slug ──────────────────────────────────────────────
exports.getStore = async (req, res) => {
  try {
    const { slug } = req.params;
    const store = await Store.findOne({ slug, status: { $ne: 'suspended' } });
    if (!store) return res.status(404).json({ success: false, error: 'Store not found' });

    const listingCount = await Listing.countDocuments({ store_id: store._id, status: 'active' });
    res.json({ success: true, store, listingCount });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

// ─── Owner: Get store by ID (full data including plan info) ─────────────────
exports.getStoreById = async (req, res) => {
  try {
    const store = await Store.findById(req.params.id).select('+ownerTokenHash');
    if (!store) return res.status(404).json({ success: false, error: 'Store not found' });

    // Verify ownership
    const token = req.get('X-Store-Owner-Token');
    if (!token) {
      return res.status(403).json({ success: false, error: 'X-Store-Owner-Token header required' });
    }
    const providedHash = crypto.createHash('sha256').update(token).digest('hex');
    if (!safeEqual(providedHash, store.ownerTokenHash)) {
      return res.status(403).json({ success: false, error: 'Not authorized to view this store' });
    }

    const listingCount = await Listing.countDocuments({ store_id: store._id, status: 'active' });
    res.json({ success: true, store, listingCount });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

// ─── Owner: Get all stores for this token ───────────────────────────────────
exports.getMyStores = async (req, res) => {
  try {
    const token = req.get('X-Store-Owner-Token');
    if (!token) {
      return res.status(403).json({ success: false, error: 'X-Store-Owner-Token header required' });
    }
    const hash = crypto.createHash('sha256').update(token).digest('hex');
    const stores = await Store.find({ ownerTokenHash: hash });
    res.json({ success: true, stores });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

// ─── Owner: Update store ────────────────────────────────────────────────────
const STORE_UPDATABLE_FIELDS = [
  'name', 'description', 'logo_url', 'cover_url',
  'category', 'subcategories',
  'phone', 'whatsapp', 'email',
  'campus', 'location', 'pickup_location',
  'opening_hours', 'closing_hours', 'open_days',
  'delivery_available', 'pickup_available', 'payment_methods',
];

exports.updateStore = async (req, res) => {
  // Declared outside try so the duplicate-slug retry in catch can still read it.
  let updates = {};
  try {
    for (const field of STORE_UPDATABLE_FIELDS) {
      if (req.body[field] !== undefined) {
        updates[field] = req.body[field];
      }
    }

    // If name changed, regenerate slug
    if (updates.name && updates.name !== req.store.name) {
      updates.slug = await generateSlug(updates.name);
    }

    const store = await Store.findByIdAndUpdate(req.params.id, updates, { returnDocument: 'after' });
    res.json({ success: true, store });
  } catch (err) {
    // Duplicate slug → retry with suffix
    if (err.code === 11000 && err.keyPattern?.slug) {
      const fallbackSlug = await generateSlug(req.body.name || req.store.name);
      const store = await Store.findByIdAndUpdate(req.params.id, { ...updates, slug: fallbackSlug }, { returnDocument: 'after' });
      return res.json({ success: true, store });
    }
    res.status(500).json({ success: false, error: err.message });
  }
};

// ─── Owner/Admin: Delete store (hard-delete + all its listings + Cloudinary) ─
// Authorization is handled by the route's storeAuth middleware. It accepts the
// store owner (X-Store-Owner-Token) and, on this route only, a valid admin
// session (X-Admin-Session — see routes/stores.js). req.storeCredentialType
// records which one authorized this delete, so the audit trail below names the
// actual credential used — owner vs admin — for this destructive cascade.
exports.deleteStore = async (req, res) => {
  const store = req.store;
  const credentialType = req.storeCredentialType || 'owner';
  const adminUser = req.admin ? req.admin.username : null;

  logger.info('Store delete initiated', {
    storeId: store._id, name: store.name, credentialType, adminUser,
  });

  // All MongoDB writes (every listing + the store itself) run inside ONE
  // session-based transaction, so a failure partway through the cascade rolls
  // the whole thing back — no half-deleted store. Cloudinary image deletion is
  // an external side effect that CANNOT join the DB transaction; it stays
  // best-effort exactly as before, and runs AFTER commit so a rollback never
  // leaves live listings pointing at already-destroyed images (orphaned
  // Cloudinary images are the harmless failure direction).
  const session = await mongoose.connection.startSession();
  try {
    // Read the listings inside the transaction so the image list reflects the
    // committed state, then capture their Cloudinary URLs for after-commit.
    session.startTransaction();
    const listings = await Listing.find({ store_id: store._id }).session(session);
    const imagesToDelete = [];
    for (const listing of listings) {
      if (listing.images && listing.images.length > 0) {
        imagesToDelete.push(...listing.images);
      }
    }
    if (store.logo_url) imagesToDelete.push(store.logo_url);
    if (store.cover_url) imagesToDelete.push(store.cover_url);

    await Listing.deleteMany({ store_id: store._id }).session(session);
    await Store.deleteOne({ _id: store._id }).session(session);

    await session.commitTransaction();

    // Post-commit best-effort Cloudinary cleanup (failures log, never throw).
    for (const imageUrl of imagesToDelete) {
      await deleteCloudinaryImage(imageUrl);
    }

    logger.info('Store cascade delete completed', {
      storeId: store._id, name: store.name, credentialType, adminUser,
    });
    res.json({ success: true, message: 'Store and all associated listings deleted' });
  } catch (err) {
    try { await session.abortTransaction(); } catch { /* already aborted */ }
    logger.warn('Store cascade delete failed', {
      storeId: store._id,
      credentialType,
      error: err.message,
    });
    res.status(500).json({ success: false, error: err.message });
  } finally {
    session.endSession();
  }
};

// ─── Owner: Attach listing to store ─────────────────────────────────────────
exports.attachListing = async (req, res) => {
  try {
    const store = req.store;
    const { listingId } = req.body;

    if (!listingId) {
      return res.status(400).json({ success: false, error: 'listingId required' });
    }

    // Load listing with ownership hash
    const listing = await Listing.findById(listingId).select('+ownerTokenHash');
    if (!listing) {
      return res.status(404).json({ success: false, error: 'Listing not found' });
    }

    // Verify listing ownership (requires X-Owner-Token from the listing owner)
    const listingToken = req.get('X-Owner-Token');
    if (!listingToken || !listing.ownerTokenHash) {
      return res.status(403).json({ success: false, error: 'Listing ownership verification required (X-Owner-Token)' });
    }
    const listingHash = crypto.createHash('sha256').update(listingToken).digest('hex');
    if (!safeEqual(listingHash, listing.ownerTokenHash)) {
      return res.status(403).json({ success: false, error: 'Not authorized to attach this listing' });
    }

    // Listing must not already be in a store
    if (listing.store_id) {
      return res.status(400).json({ success: false, error: 'Listing is already in a store' });
    }

    // Listing must not be expired
    if (listing.expiresAt < new Date()) {
      return res.status(400).json({ success: false, error: 'Cannot attach an expired listing' });
    }

    // Check listing limit
    const count = await Listing.countDocuments({ store_id: store._id, status: 'active' });
    if (count >= store.listing_limit) {
      return res.status(400).json({
        success: false,
        error: `Store listing limit reached (${store.listing_limit}). Upgrade your plan or remove existing listings.`,
      });
    }

    // Attach
    listing.store_id = store._id;
    await listing.save();

    res.json({ success: true, message: 'Listing attached to store' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

// ─── Owner: Detach listing from store ───────────────────────────────────────
exports.detachListing = async (req, res) => {
  try {
    const store = req.store;
    const { listingId } = req.body;

    if (!listingId) {
      return res.status(400).json({ success: false, error: 'listingId required' });
    }

    const listing = await Listing.findById(listingId).select('+ownerTokenHash');
    if (!listing) {
      return res.status(404).json({ success: false, error: 'Listing not found' });
    }

    // Listing must belong to this store
    if (!listing.store_id || listing.store_id.toString() !== store._id.toString()) {
      return res.status(400).json({ success: false, error: 'Listing is not in this store' });
    }

    // Verify listing ownership
    const listingToken = req.get('X-Owner-Token');
    if (!listingToken || !listing.ownerTokenHash) {
      return res.status(403).json({ success: false, error: 'Listing ownership verification required (X-Owner-Token)' });
    }
    const listingHash = crypto.createHash('sha256').update(listingToken).digest('hex');
    if (!safeEqual(listingHash, listing.ownerTokenHash)) {
      return res.status(403).json({ success: false, error: 'Not authorized to detach this listing' });
    }

    // Detach
    listing.store_id = null;
    await listing.save();

    res.json({ success: true, message: 'Listing removed from store' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};
