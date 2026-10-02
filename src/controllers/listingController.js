const mongoose = require('mongoose');
const Listing = require('../models/Listing');
const Store = require('../models/Store');
const cloudinary = require('../config/cloudinary');
const logger = require('../config/logger');
const { emit, adminActor, ownerActor } = require('../services/auditService');
const { isOwnerOrAdmin } = require('../middleware/listingAuth');
const { VALID_CONDITIONS } = require('../config/listingOptions');
const { isHttpUrl } = require('../utils/safeUrl');
const inputLimits = require('../config/inputLimits');
const { listingView } = require('../utils/publicView');
const { checkListing } = require('../services/moderationService');

// Escape special regex characters in user input so it can be safely embedded
// in a $regex query (prevents crashes on invalid patterns and ReDoS abuse).
function escapeRegex(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Get all listings (paginated; default 50/cap 100 — low enough to slow bulk
// scrapers, high enough for normal browsing). Only approved listings are shown.
exports.getListings = async (req, res, next) => {
  try {
    const { category, condition, search, page = 1, limit = 50 } = req.query;
    await Listing.updateMany(
      { featured: true, featuredUntil: { $ne: null, $lt: new Date() } },
      { $set: { featured: false, boostType: null } }
    );
    const pageNum = Math.max(1, Number.parseInt(page, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, Number.parseInt(limit, 10) || 50));
    // Store-scoped browsing: resolve the store's visibility BEFORE building the
    // listing query, so the inventory of a suspended, flagged or removed store
    // is hidden. A malformed or unknown store id returns an empty envelope (and
    // never an error) so store existence is not revealed. Only a malformed id
    // skips the database; a syntactically valid id is looked up.
    if (req.query.store_id) {
      const storeId = req.query.store_id;
      const validStoreId = typeof storeId === 'string'
        && mongoose.isValidObjectId(storeId)
        && /^[0-9a-fA-F]{24}$/.test(storeId);
      const visibleStore = validStoreId
        ? await Store.findOne({
            _id: storeId,
            status: { $ne: 'suspended' },
            moderationStatus: { $nin: ['flagged', 'removed'] },
          })
        : null;
      if (!visibleStore) {
        return res.json({ success: true, count: 0, total: 0, page: pageNum, totalPages: 0, listings: [] });
      }
    }
    const filter = { status: 'active', moderationStatus: 'approved' };
    if (category) filter.category = category;
    if (condition) filter.condition = condition;
    if (search) filter.title = { $regex: escapeRegex(search), $options: 'i' };
    if (req.query.store_id) filter.store_id = req.query.store_id;
    const skip = (pageNum - 1) * limitNum;
    const [listings, total] = await Promise.all([
      // .lean() makes these plain objects (NOT Mongoose documents). The list
      // serialization below spreads each record, and spreading a Mongoose
      // document only yields its internal fields ($__, _doc, $isNew) — never
      // the actual data. .lean() avoids that entirely and skips document
      // instantiation overhead.
      // priorityBroadcast (paid KSh 30 re-broadcast) outranks plain featured.
      Listing.find(filter).populate('store_id', 'name slug').sort({ priorityBroadcast: -1, featured: -1, createdAt: -1 }).skip(skip).limit(limitNum).lean(),
      Listing.countDocuments(filter),
    ]);
    // Anti-scraping: never expose contact numbers in list responses. Phone
    // numbers are only available from the per-listing detail endpoint, which
    // is individually rate-limited and costs a request per item.
    // Also extract store info into flat fields for the frontend.
    const sanitized = listings.map(({ store_id, ...rest }) => ({
      ...listingView(rest, { includeContact: false }),
      store_name: store_id?.name || null,
      store_slug: store_id?.slug || null,
    }));
    res.json({
      success: true,
      count: sanitized.length,
      total,
      page: pageNum,
      totalPages: Math.ceil(total / limitNum),
      listings: sanitized,
    });
  } catch (err) {
    return next(err);
  }
};

// Get single listing
exports.getListing = async (req, res, next) => {
  try {
    const listing = await Listing.findOneAndUpdate(
      { _id: req.params.id, status: 'active', moderationStatus: 'approved' },
      { $inc: { views: 1 } },
      { returnDocument: 'after' }
    ).select('+ownerTokenHash');
    if (!listing) return res.status(404).json({ success: false, error: 'Listing not found' });

    // Contact PII (sellerWhatsapp) is only returned to the listing owner
    // (valid X-Owner-Token) or an authenticated admin; the public sees the
    // listing without it. The owner hash is never serialized either way.
    const authz = await isOwnerOrAdmin(req, listing);
    const payload = listingView(listing, { includeContact: authz.authorized });
    res.json({ success: true, listing: payload });
  } catch (err) {
    return next(err);
  }
};

// Update listing
// Whitelist of user-editable fields — prevents API callers from tampering with
// monetization/lifecycle/system fields (featured, featuredUntil, boostType, views,
// status, package, expiresAt, broadcastSent, priorityBroadcast, timestamps, _id).
const UPDATABLE_FIELDS = [
  'title',
  'category',
  'subcategory',
  'condition',
  'price',
  'description',
  'images',
  'sellerName',
  'sellerWhatsapp',
  'location',
];

exports.updateListing = async (req, res, next) => {
  try {
    // Fetch the target first (with the hidden hash) so ownership can be
    // verified BEFORE any mutation is applied.
    const target = await Listing.findById(req.params.id).select('+ownerTokenHash');
    if (!target) return res.status(404).json({ success: false, error: 'Listing not found' });
    const authz = await isOwnerOrAdmin(req, target);
    if (!authz.authorized) {
      return res.status(403).json({ success: false, error: 'Not authorized' });
    }
    // A removed listing is terminal: neither its owner nor an admin may edit it.
    if (target.moderationStatus === 'removed') {
      return res.status(409).json({ success: false, error: 'Listing has been removed and can no longer be edited' });
    }
    const updates = {};
    for (const field of UPDATABLE_FIELDS) {
      if (req.body[field] !== undefined) {
        updates[field] = req.body[field];
      }
    }
    // Reject oversized free-text and image arrays before any write.
    const listingCaps = inputLimits.listing;
    for (const [field, cap] of Object.entries(listingCaps)) {
      if (typeof cap !== 'number') continue;
      const value = updates[field];
      if (typeof value === 'string' && value.trim().length > cap) {
        return res.status(400).json({ success: false, error: `${field} exceeds the maximum length of ${cap} characters` });
      }
    }
    if (Array.isArray(updates.images) && updates.images.length > listingCaps.images.maxItems) {
      return res.status(400).json({ success: false, error: `images exceeds the maximum of ${listingCaps.images.maxItems} items` });
    }
    // Bound the two fields the UI renders into HTML elements. `condition` is a
    // finite vocabulary; image entries are media URLs the frontend feeds to
    // <img src>. Rejecting here means a bad value is never stored in the first
    // place, not merely escaped on render.
    if (updates.condition !== undefined && !VALID_CONDITIONS.includes(updates.condition)) {
      return res.status(400).json({ success: false, error: 'Invalid condition' });
    }
    if (updates.images !== undefined
      && (!Array.isArray(updates.images) || !updates.images.every(isHttpUrl))) {
      return res.status(400).json({ success: false, error: 'images must be an array of http(s) image URLs' });
    }
    // Re-screen the effective document (stored fields + this edit) so an edit
    // cannot smuggle prohibited content past the creation-time check. A clean
    // edit never sets 'approved' — a flagged listing stays flagged until an
    // admin approves it.
    const effective = typeof target.toObject === 'function' ? target.toObject() : { ...target };
    Object.assign(effective, updates);
    if (!checkListing(effective).approved) {
      updates.moderationStatus = 'flagged';
    }
    const listing = await Listing.findByIdAndUpdate(req.params.id, updates, { returnDocument: 'after' });
    res.json({ success: true, listing });
  } catch (err) {
    return next(err);
  }
};

// Delete listing — hard delete (no archiving). Removes Cloudinary images first, then the DB record.
exports.deleteListing = async (req, res, next) => {
  try {
    const listing = await Listing.findById(req.params.id).select('+ownerTokenHash');
    if (!listing) return res.status(404).json({ success: false, error: 'Listing not found' });
    const authz = await isOwnerOrAdmin(req, listing);
    if (!authz.authorized) {
      return res.status(403).json({ success: false, error: 'Not authorized' });
    }

    if (listing.images && listing.images.length > 0) {
      for (const imageUrl of listing.images) {
        // eslint-disable-next-line security/detect-unsafe-regex -- double-anchored, bounded-length URLs; worst case is quadratic over ~100 chars, not ReDoS
        const match = imageUrl.match(/\/upload\/(?:v\d+\/)?(.+)\.\w+$/);
        if (match) {
          try {
            await cloudinary.uploader.destroy(match[1]);
          } catch (err) {
            logger.warn('Failed to delete Cloudinary image', { error: err.message });
          }
        }
      }
    }

    await Listing.deleteOne({ _id: req.params.id });
    emit({
      actor: authz.credential === 'owner' ? ownerActor(req) : adminActor(req),
      action: 'listing.delete',
      resource: 'listing',
      resourceId: String(req.params.id),
      result: 'success',
      metadata: { credential: authz.credential },
    });
    res.json({ success: true, message: 'Listing deleted' });
  } catch (err) {
    return next(err);
  }
};

// Admin moderation action — approve, flag, or remove a listing.
// Warded by full admin auth (adminAuth middleware) so a leaked admin key alone
// cannot alter moderation state without a valid TOTP session.
exports.moderateListing = async (req, res, next) => {
  try {
    const { action } = req.body;
    const VALID_ACTIONS = ['approved', 'flagged', 'removed'];
    if (!VALID_ACTIONS.includes(action)) {
      return res.status(400).json({ success: false, error: 'Action must be approved, flagged, or removed' });
    }
    const listing = await Listing.findByIdAndUpdate(
      req.params.id,
      { moderationStatus: action },
      { returnDocument: 'after' }
    );
    if (!listing) return res.status(404).json({ success: false, error: 'Listing not found' });
    emit({
      actor: adminActor(req),
      action: 'listing.moderate',
      resource: 'listing',
      resourceId: String(req.params.id),
      result: 'success',
      metadata: { moderationStatus: action },
    });
    res.json({ success: true, listing });
  } catch (err) {
    return next(err);
  }
};