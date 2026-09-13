const crypto = require('crypto');
const Listing = require('../models/Listing');
const cloudinary = require('../config/cloudinary');
const logger = require('../config/logger');
const { authenticateAdmin } = require('../middleware/adminAuth');

// Constant-time string comparison. Both inputs are hashed to a fixed 32-byte
// digest first, so crypto.timingSafeEqual never throws on length mismatch and
// the comparison time reveals nothing about content or length.
function safeEqual(a, b) {
  const hashA = crypto.createHash('sha256').update(String(a)).digest();
  const hashB = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(hashA, hashB);
}

// Authorization for mutating a listing. Returns { authorized, credential, required }:
//   - authorized: whether the request is authenticated
//   - credential: the factor that actually granted access (for logs)
//   - required:   the credential(s) that WOULD grant access under the current
//                 2FA state (used only to render accurate 403 messages)
//
// Two acceptable factors:
//  1) X-Owner-Token: sha256 of the provided raw token must equal the hash
//     stored on the listing (compared with crypto.timingSafeEqual, not ===), or
//  2) Admin auth — 2FA-aware logic consolidated in middleware/adminAuth.js
//     (authenticateAdmin) so each mode's rules live in exactly one place:
//     a) 2FA enabled: a valid X-Admin-Session HMAC token (issued by POST
//        /api/admin/login after ADMIN_KEY + TOTP code) is required. The raw
//        X-Admin-Key alone is rejected so a leaked key can't bypass 2FA.
//     b) 2FA not enabled: the legacy X-Admin-Key is accepted as before.
async function isOwnerOrAdmin(req, listing) {
  // Owner path — always available regardless of 2FA state. Unchanged.
  const ownerToken = req.get('X-Owner-Token');
  if (ownerToken && listing.ownerTokenHash) {
    const providedHash = crypto.createHash('sha256').update(ownerToken).digest('hex');
    if (safeEqual(providedHash, listing.ownerTokenHash)) {
      return { authorized: true, credential: 'owner' };
    }
  }

  // Admin path — shared 2FA-aware logic from middleware/adminAuth.js.
  const admin = await authenticateAdmin(req);
  if (admin.payload) {
    return {
      authorized: true,
      credential: admin.needs2fa ? 'admin-session' : 'admin-key',
    };
  }
  return {
    authorized: false,
    credential: null,
    required: admin.needs2fa
      ? 'a valid X-Owner-Token or X-Admin-Session header.'
      : 'a valid X-Owner-Token or X-Admin-Key header.',
  };
}

// Escape special regex characters in user input so it can be safely embedded
// in a $regex query (prevents crashes on invalid patterns and ReDoS abuse).
function escapeRegex(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Get all listings (paginated; default 50/cap 100 — low enough to slow bulk
// scrapers, high enough for normal browsing). Only approved listings are shown.
exports.getListings = async (req, res) => {
  try {
    const { category, condition, search, page = 1, limit = 50 } = req.query;
    await Listing.updateMany(
      { featured: true, featuredUntil: { $ne: null, $lt: new Date() } },
      { $set: { featured: false, boostType: null } }
    );
    let filter = { status: 'active', moderationStatus: 'approved' };
    if (category) filter.category = category;
    if (condition) filter.condition = condition;
    if (search) filter.title = { $regex: escapeRegex(search), $options: 'i' };
    if (req.query.store_id) filter.store_id = req.query.store_id;
    const pageNum = Math.max(1, Number.parseInt(page, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, Number.parseInt(limit, 10) || 50));
    const skip = (pageNum - 1) * limitNum;
    const [listings, total] = await Promise.all([
      // .lean() makes these plain objects (NOT Mongoose documents). The list
      // serialization below spreads each record, and spreading a Mongoose
      // document only yields its internal fields ($__, _doc, $isNew) — never
      // the actual data. .lean() avoids that entirely and skips document
      // instantiation overhead.
      Listing.find(filter).populate('store_id', 'name slug').sort({ featured: -1, createdAt: -1 }).skip(skip).limit(limitNum).lean(),
      Listing.countDocuments(filter),
    ]);
    // Anti-scraping: never expose contact numbers in list responses. Phone
    // numbers are only available from the per-listing detail endpoint, which
    // is individually rate-limited and costs a request per item.
    // Also extract store info into flat fields for the frontend.
    const sanitized = listings.map(({ sellerWhatsapp, store_id, ...rest }) => ({
      ...rest,
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
    res.status(500).json({ success: false, error: err.message });
  }
};

// Get single listing
exports.getListing = async (req, res) => {
  try {
    const listing = await Listing.findOneAndUpdate(
      { _id: req.params.id, status: 'active', moderationStatus: 'approved' },
      { $inc: { views: 1 } },
      { returnDocument: 'after' }
    );
    if (!listing) return res.status(404).json({ success: false, error: 'Listing not found' });
    res.json({ success: true, listing });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
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

exports.updateListing = async (req, res) => {
  try {
    // Fetch the target first (with the hidden hash) so ownership can be
    // verified BEFORE any mutation is applied.
    const target = await Listing.findById(req.params.id).select('+ownerTokenHash');
    if (!target) return res.status(404).json({ success: false, error: 'Listing not found' });
    const authz = await isOwnerOrAdmin(req, target);
    if (!authz.authorized) {
      return res.status(403).json({ success: false, error: `Not authorized to edit this listing. Provide ${authz.required}` });
    }
    const updates = {};
    for (const field of UPDATABLE_FIELDS) {
      if (req.body[field] !== undefined) {
        updates[field] = req.body[field];
      }
    }
    const listing = await Listing.findByIdAndUpdate(req.params.id, updates, { returnDocument: 'after' });
    res.json({ success: true, listing });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

// Delete listing — hard delete (no archiving). Removes Cloudinary images first, then the DB record.
exports.deleteListing = async (req, res) => {
  try {
    const listing = await Listing.findById(req.params.id).select('+ownerTokenHash');
    if (!listing) return res.status(404).json({ success: false, error: 'Listing not found' });
    const authz = await isOwnerOrAdmin(req, listing);
    if (!authz.authorized) {
      return res.status(403).json({ success: false, error: `Not authorized to delete this listing. Provide ${authz.required}` });
    }

    if (listing.images && listing.images.length > 0) {
      for (const imageUrl of listing.images) {
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
    res.json({ success: true, message: 'Listing deleted' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

// Admin moderation action — approve, flag, or remove a listing.
// Warded by full admin auth (adminAuth middleware) so a leaked admin key alone
// cannot alter moderation state without a valid TOTP session.
exports.moderateListing = async (req, res) => {
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
    res.json({ success: true, listing });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};