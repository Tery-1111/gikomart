const crypto = require('crypto');
const Store = require('../models/Store');
const Listing = require('../models/Listing');
const cloudinary = require('../config/cloudinary');
const logger = require('../config/logger');
const { emit, adminActor, ownerActor } = require('../services/auditService');
const { checkStore, checkListing } = require('../services/moderationService');
const mongoose = require('mongoose');
const inputLimits = require('../config/inputLimits');
const { storeView, listingView } = require('../utils/publicView');
const { authenticateAdmin } = require('../middleware/adminAuth');
// Store state drives listing visibility on the browse endpoint (listings of a
// suspended/flagged/removed store are hidden), so these writes clear it.
const { invalidateListingsCache } = require('../utils/ttlCache');
// Included-listing publication (POST /api/stores/:id/listings) reuses the paid
// path's safeguards verbatim: the acceptance rules, input limits, condition
// catalog, http(s)-only image URLs, content screen and the payment path's
// blocked-contact rule + Upload attached-marking (imported indirection only —
// no payment machinery is invoked).
const { ACCEPTANCE_TYPES } = require('../config/termsVersions');
const { validateAcceptanceToken, recordAcceptance } = require('../services/termsAcceptanceService');
const { VALID_CONDITIONS } = require('../config/listingOptions');
const { isHttpUrl } = require('../utils/safeUrl');
const { isContactBlocked, markUploadsAttached, LISTING_DATA_ALLOWLIST } = require('./paymentController');

// Constant-time comparison (same pattern as listingController.js)
function safeEqual(a, b) {
  const hashA = crypto.createHash('sha256').update(String(a)).digest();
  const hashB = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(hashA, hashB);
}

// Generate a URL-friendly slug from a store name.
function slugifyBase(name) {
  const base = String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return base || 'store';
}

// Extract Cloudinary public_id from a URL (same pattern as listingController.js)
function extractPublicId(imageUrl) {
  // eslint-disable-next-line security/detect-unsafe-regex -- double-anchored, bounded-length URLs; worst case is quadratic over ~100 chars, not ReDoS
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
exports.getStore = async (req, res, next) => {
  try {
    const { slug } = req.params;
    const store = await Store.findOne({ slug, status: { $ne: 'suspended' }, moderationStatus: { $nin: ['flagged', 'removed'] } }).select('+ownerTokenHash');
    if (!store) return res.status(404).json({ success: false, error: 'Store not found' });

    // Contact fields are PII: only the owner (valid X-Store-Owner-Token) or an
    // authenticated admin may see them on this public route.
    const token = req.get('X-Store-Owner-Token');
    let authorized = false;
    if (token && store.ownerTokenHash) {
      const providedHash = crypto.createHash('sha256').update(token).digest('hex');
      if (safeEqual(providedHash, store.ownerTokenHash)) authorized = true;
    }
    if (!authorized) {
      const admin = await authenticateAdmin(req);
      if (admin.payload) authorized = true;
    }

    const listingCount = await Listing.countDocuments({ store_id: store._id, status: 'active' });
    const payload = storeView(store, { includeContact: authorized });
    res.json({ success: true, store: payload, listingCount });
  } catch (err) {
    return next(err);
  }
};

// ─── Owner: Get store by ID (full data including plan info) ─────────────────
exports.getStoreById = async (req, res, next) => {
  try {
    const store = await Store.findById(req.params.id).select('+ownerTokenHash');
    if (!store) return res.status(404).json({ success: false, error: 'Store not found' });

    // Verify ownership
    const token = req.get('X-Store-Owner-Token');
    if (!token) {
      return res.status(403).json({ success: false, error: 'Not authorized' });
    }
    const providedHash = crypto.createHash('sha256').update(token).digest('hex');
    if (!safeEqual(providedHash, store.ownerTokenHash)) {
      return res.status(403).json({ success: false, error: 'Not authorized' });
    }

    const listingCount = await Listing.countDocuments({ store_id: store._id, status: 'active' });
    // The hash was loaded with .select('+ownerTokenHash') for the ownership
    // check above — strip it before the response so the secret never leaves
    // the server.
    res.json({ success: true, store: storeView(store, { includeContact: true }), listingCount });
  } catch (err) {
    return next(err);
  }
};

// ─── Owner: Get all stores for this token ───────────────────────────────────
exports.getMyStores = async (req, res, next) => {
  try {
    const token = req.get('X-Store-Owner-Token');
    if (!token) {
      return res.status(403).json({ success: false, error: 'Not authorized' });
    }
    const hash = crypto.createHash('sha256').update(token).digest('hex');
    const stores = await Store.find({ ownerTokenHash: hash });
    res.json({ success: true, stores: stores.map((s) => storeView(s, { includeContact: true })) });
  } catch (err) {
    return next(err);
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

exports.updateStore = async (req, res, next) => {
  // Declared outside try so the duplicate-slug retry in catch can still read it.
  const updates = {};
  try {
    for (const field of STORE_UPDATABLE_FIELDS) {
      if (req.body[field] !== undefined) {
        updates[field] = req.body[field];
      }
    }

    // Reject oversized free-text and oversized arrays before any write.
    const storeCaps = inputLimits.store;
    for (const [field, cap] of Object.entries(storeCaps)) {
      if (typeof cap !== 'number') continue;
      const value = updates[field];
      if (typeof value === 'string' && value.trim().length > cap) {
        return res.status(400).json({ success: false, error: `${field} exceeds the maximum length of ${cap} characters` });
      }
    }
    for (const [field, cfg] of [['subcategories', storeCaps.subcategories], ['payment_methods', storeCaps.payment_methods]]) {
      const value = updates[field];
      if (!Array.isArray(value)) continue;
      if (value.length > cfg.maxItems) {
        return res.status(400).json({ success: false, error: `${field} exceeds the maximum of ${cfg.maxItems} items` });
      }
      if (value.some((item) => typeof item === 'string' && item.trim().length > cfg.item)) {
        return res.status(400).json({ success: false, error: `${field} items exceed the maximum length of ${cfg.item} characters` });
      }
    }

    // A removed store is terminal: its owner may not edit it. (A removed store
    // is normally also suspended, which storeAuth rejects earlier with 403; this
    // covers a removed-but-still-active row.)
    if (req.store.moderationStatus === 'removed') {
      return res.status(409).json({ success: false, error: 'Store has been removed and can no longer be edited' });
    }

    // If name changed, derive the new slug and REFUSE if another store
    // already owns it (409 — actionable) instead of silently assigning a
    // suffixed slug the user never asked for.
    if (updates.name && updates.name !== req.store.name) {
      const desired = slugifyBase(updates.name);
      const clash = await Store.findOne({ slug: desired, _id: { $ne: req.params.id } });
      if (clash) {
        return res.status(409).json({ success: false, error: 'That slug is already taken' });
      }
      updates.slug = desired;
    }

    // Media fields are rendered into <img src> / CSS url() by the frontend, so
    // only http(s) URLs are accepted. null/'' clears the field and stays legal.
    for (const field of ['logo_url', 'cover_url']) {
      const value = updates[field];
      if (value !== undefined && value !== null && value !== '' && !isHttpUrl(value)) {
        return res.status(400).json({ success: false, error: `${field} must be an http(s) URL` });
      }
    }

    // Re-screen the effective document (stored fields + this edit) so an edit
    // cannot smuggle prohibited content past the create-time check. A clean edit
    // never sets 'approved' — a flagged store stays flagged until an admin acts.
    const effective = typeof req.store.toObject === 'function' ? req.store.toObject() : { ...req.store };
    Object.assign(effective, updates);
    if (!checkStore(effective).approved) {
      updates.moderationStatus = 'flagged';
    }

    const store = await Store.findByIdAndUpdate(req.params.id, updates, { returnDocument: 'after' });
    emit({
      actor: req.admin ? adminActor(req) : ownerActor(req),
      action: 'store.update',
      resource: 'store',
      resourceId: String(req.params.id),
      result: 'success',
      metadata: { updatedFieldCount: Object.keys(updates).length },
    });
    // A separate signal for the edit having auto-flagged the store, so the flag
    // is visible without the field-count metadata changing shape.
    if (updates.moderationStatus === 'flagged') {
      emit({
        actor: req.admin ? adminActor(req) : ownerActor(req),
        action: 'store.auto_flagged',
        resource: 'store',
        resourceId: String(req.params.id),
        result: 'success',
        metadata: { source: 'update' },
      });
    }
    res.json({ success: true, store });
  } catch (err) {
    // Race-window duplicate (two concurrent renames to the same free slug):
    // same user-facing contract as the pre-check above.
    if (err.code === 11000 && err.keyPattern?.slug) {
      return res.status(409).json({ success: false, error: 'That slug is already taken' });
    }
    return next(err);
  }
};

// ─── Owner/Admin: Delete store (hard-delete + all its listings + Cloudinary) ─
// Authorization is handled by the route's storeAuth middleware. It accepts the
// store owner (X-Store-Owner-Token) and, on this route only, a valid admin
// session (X-Admin-Session — see routes/stores.js). req.storeCredentialType
// records which one authorized this delete, so the audit trail below names the
// actual credential used — owner vs admin — for this destructive cascade.
exports.deleteStore = async (req, res, next) => {
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

    // Committed: the store and its listings have left the browse set
    // (in-memory, post-commit so a rolled-back transaction clears nothing).
    invalidateListingsCache();

    // Post-commit best-effort Cloudinary cleanup (failures log, never throw).
    for (const imageUrl of imagesToDelete) {
      await deleteCloudinaryImage(imageUrl);
    }

    logger.info('Store cascade delete completed', {
      storeId: store._id, name: store.name, credentialType, adminUser,
    });
    emit({
      actor: req.admin ? adminActor(req) : ownerActor(req),
      action: 'store.delete',
      resource: 'store',
      resourceId: String(store._id),
      result: 'success',
      metadata: { credentialType },
    });
    res.json({ success: true, message: 'Store and all associated listings deleted' });
  } catch (err) {
    try { await session.abortTransaction(); } catch { /* already aborted */ }
    logger.warn('Store cascade delete failed', {
      storeId: store._id,
      credentialType,
      error: err.message,
    });
    return next(err);
  } finally {
    session.endSession();
  }
};

// ─── Owner: Attach listing to store ─────────────────────────────────────────
exports.attachListing = async (req, res, next) => {
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
      return res.status(403).json({ success: false, error: 'Not authorized' });
    }
    const listingHash = crypto.createHash('sha256').update(listingToken).digest('hex');
    if (!safeEqual(listingHash, listing.ownerTokenHash)) {
      return res.status(403).json({ success: false, error: 'Not authorized' });
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

    // A removed listing is terminal: it can never be attached to a store.
    if (listing.moderationStatus === 'removed') {
      return res.status(409).json({ success: false, error: 'Removed listings cannot be attached to a store' });
    }

    // Attach
    listing.store_id = store._id;
    await listing.save();

    emit({
      actor: req.admin ? adminActor(req) : ownerActor(req),
      action: 'store.attach_listing',
      resource: 'store',
      resourceId: String(store._id),
      result: 'success',
      metadata: { listingId: String(listing._id) },
    });
    res.json({ success: true, message: 'Listing attached to store' });
  } catch (err) {
    return next(err);
  }
};

// ─── Owner: Detach listing from store ───────────────────────────────────────
exports.detachListing = async (req, res, next) => {
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
      return res.status(403).json({ success: false, error: 'Not authorized' });
    }
    const listingHash = crypto.createHash('sha256').update(listingToken).digest('hex');
    if (!safeEqual(listingHash, listing.ownerTokenHash)) {
      return res.status(403).json({ success: false, error: 'Not authorized' });
    }

    // Detach
    listing.store_id = null;
    await listing.save();

    emit({
      actor: req.admin ? adminActor(req) : ownerActor(req),
      action: 'store.detach_listing',
      resource: 'store',
      resourceId: String(store._id),
      result: 'success',
      metadata: { listingId: String(listing._id) },
    });
    res.json({ success: true, message: 'Listing removed from store' });
  } catch (err) {
    return next(err);
  }
};

// ─── Owner: Publish a Store-included listing (no payment) ──────────────────
// The Store plan's listing capacity is an entitlement: while the store is
// active and unexpired (both enforced by storeAuth requireActive), its owner
// publishes listings into it WITHOUT paying the standalone listing fee.
//
// Capacity enforcement is transactional (same MongoDB startSession pattern as
// deleteStore): the active-listing count is re-read on the transaction's
// snapshot IMMEDIATELY before the insert, so two concurrent publications
// cannot both accept a last slot — one sees the other's committed insert on a
// fresh snapshot, MongoDB aborts the loser, and nothing is written. This is
// deliberately NOT a persisted counter (listing_limit stays the one capacity
// field and remains derivable from listing state at all times).
//
// Included-listing expiry ADOPTS THE STORE'S expiry (expiresAt =
// store.expires_at): a listing published under a plan lives exactly as long
// as that plan period — there is no separate included-listing duration.
exports.createStoreListing = async (req, res, next) => {
  try {
    const store = req.store;
    const { listingData } = req.body || {};

    if (!listingData || typeof listingData !== 'object') {
      return res.status(400).json({ success: false, error: 'Missing listing details' });
    }

    // Terms: the same seller-publication acceptance the paid initiate-listing
    // path enforces (LISTING_PUBLICATION), with a zero-fee label because the
    // publication is covered by the store plan, not a new charge.
    const acceptValidation = validateAcceptanceToken(req.body.acceptance, ACCEPTANCE_TYPES.LISTING_PUBLICATION);
    if (!acceptValidation.valid) {
      return res.status(400).json({
        success: false,
        error: `Terms acceptance required: ${acceptValidation.error}`,
      });
    }
    const errors = [];
    // Field validation and caps: identical rules to initiateListing minus the
    // payment-only fields, so BOTH creation paths accept the same content.
    if (typeof listingData.title !== 'string' || !listingData.title.trim()) errors.push('title');
    if (typeof listingData.category !== 'string' || !listingData.category.trim()) errors.push('category');
    if (!VALID_CONDITIONS.includes(listingData.condition)) errors.push('condition');
    // Image entries are rendered into <img src> — reject non-http(s) schemes.
    if (listingData.images !== undefined
      && (!Array.isArray(listingData.images) || !listingData.images.every(isHttpUrl))) errors.push('images');
    const price = Number(listingData.price);
    if (!Number.isFinite(price) || price < 0) errors.push('price');
    if (typeof listingData.description !== 'string' || !listingData.description.trim()) errors.push('description');
    if (typeof listingData.sellerName !== 'string' || !listingData.sellerName.trim()) errors.push('sellerName');
    if (typeof listingData.sellerWhatsapp !== 'string' || !listingData.sellerWhatsapp.trim()) errors.push('sellerWhatsapp');
    // Length caps: reject oversized free-text (and too many images) upfront.
    const listingCaps = inputLimits.listing;
    for (const [field, cap] of Object.entries(listingCaps)) {
      if (typeof cap !== 'number') continue;
      const value = listingData[field];
      if (typeof value === 'string' && value.trim().length > cap) errors.push(field);
    }
    if (Array.isArray(listingData.images) && listingData.images.length > listingCaps.images.maxItems) {
      errors.push('images');
    }
    if (listingData.store_id !== undefined && listingData.store_id !== null && listingData.store_id !== '') {
      errors.push('store_id');
    }
    if (errors.length > 0) {
      return res.status(400).json({ success: false, error: `Invalid or missing listing details: ${errors.join(', ')}` });
    }
    listingData.price = price;

    // Blocked contacts cannot publish, exactly like payment initiation.
    if (await isContactBlocked([listingData.sellerWhatsapp])) {
      emit({
        actor: ownerActor(req),
        action: 'payment.blocked_contact',
        resource: 'payment',
        result: 'failure',
        metadata: { route: 'store-listing' },
      });
      return res.status(403).json({ success: false, error: 'This number cannot be used on GikoMart' });
    }

    // Mark this listing's images attached BEFORE the insert so the orphan
    // sweep cannot destroy them while the reference is being written (same
    // ordering as the paid initiate path).
    if (Array.isArray(listingData.images) && listingData.images.length > 0) {
      await markUploadsAttached(listingData.images);
    }

    // Allowlist-copy: keep exactly the validated content fields and drop every
    // other client-supplied key before anything is persisted.
    const cleanListingData = {};
    for (const key of LISTING_DATA_ALLOWLIST) {
      if (listingData[key] !== undefined) cleanListingData[key] = listingData[key];
    }

    const moderation = checkListing(cleanListingData);
    const session = await mongoose.connection.startSession();

    let listing;
    try {
      await session.withTransaction(async () => {
        // Recount on the transaction snapshot. A rival publication that slips
        // in before this read is seen here; one that races the insert aborts
        // on a write conflict, and any driver retry of the callback re-runs
        // this recount on a fresh snapshot before doing anything else — the
        // verdict is always re-derived, never inherited.
        const count = await Listing.countDocuments({ store_id: store._id, status: 'active' }, { session });
        if (count >= store.listing_limit) {
          throw new Error(`Store listing limit reached (${store.listing_limit}). Remove a listing or use a standalone listing package.`);
        }
        [listing] = await Listing.create([{
          // Key-by-key copy of the allowlist — no spread — so a crafted payload
          // cannot inject featured, views, status or boostType here either.
          title: cleanListingData.title,
          category: cleanListingData.category,
          subcategory: cleanListingData.subcategory,
          condition: cleanListingData.condition,
          price: cleanListingData.price,
          description: cleanListingData.description,
          images: cleanListingData.images || [],
          sellerName: cleanListingData.sellerName,
          sellerWhatsapp: cleanListingData.sellerWhatsapp,
          location: cleanListingData.location,
          // Born in the store (INV-3): no standalone-then-attach hop.
          store_id: store._id,
          // The plan covers publication: no listing charge (INV-2), so this is
          // NOT routed through payments and carries no paymentId.
          package: 'store',
          // Included listings inherit the plan period they were published in:
          // expiresAt = store.expires_at exactly.
          expiresAt: store.expires_at,
          moderationStatus: moderation.approved ? 'approved' : 'flagged',
          // The store's owner hash governs this listing: the store token is the
          // single seller credential for everything the store publishes.
          ownerTokenHash: store.ownerTokenHash,
        }], { session });
      }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } });
    } catch (err) {
      if (err instanceof Error && /Store listing limit reached/.test(err.message)) {
        return res.status(409).json({ success: false, error: err.message });
      }
      // Everything else: the transaction already rolled back atomically.
      throw err;
    } finally {
      session.endSession();
    }

    await recordAcceptance({
      acceptanceType: ACCEPTANCE_TYPES.LISTING_PUBLICATION,
      versions: acceptValidation.versions,
      action: 'STORE_PUBLISH:' + store.plan,
      phone: null,
      whatsapp: cleanListingData.sellerWhatsapp,
      ownerTokenHash: store.ownerTokenHash,
      ip: req.ip,
      userAgent: req.get('user-agent') || '',
      listingId: listing._id,
      storeId: store._id,
      fee: { amount: 0, currency: 'KES', label: 'Included in store plan: ' + store.plan },
      metadata: {
        listingTitle: cleanListingData.title || null,
        listingCategory: cleanListingData.category || null,
      },
    });

    // A new listing may enter the public browse set — drop cached page 1.
    invalidateListingsCache();

    emit({
      actor: ownerActor(req),
      action: 'store.create_listing',
      resource: 'listing',
      resourceId: String(listing._id),
      result: 'success',
      metadata: {
        storeId: String(store._id),
        flagged: !moderation.approved,
        package: 'store',
      },
    });

    res.status(201).json({
      success: true,
      message: 'Listing published in your store — covered by your plan',
      listing: listingView(listing, { includeContact: true }),
    });
  } catch (err) {
    return next(err);
  }
};

// ─── Admin: Moderate store (approve / flag / remove) ────────────────────────
// 'removed' also suspends the store (drops it from public reads and blocks its
// owner); 'approved' clears a suspension. Gated by adminAuth on the route.
exports.moderateStore = async (req, res, next) => {
  try {
    const { action } = req.body;
    const VALID_ACTIONS = ['approved', 'flagged', 'removed'];
    if (!VALID_ACTIONS.includes(action)) {
      return res.status(400).json({ success: false, error: 'Action must be approved, flagged, or removed' });
    }

    const store = await Store.findById(req.params.id);
    if (!store) return res.status(404).json({ success: false, error: 'Store not found' });

    const update = { moderationStatus: action };
    if (action === 'removed') {
      update.status = 'suspended';
    } else if (action === 'approved' && store.status === 'suspended') {
      update.status = 'active';
    }

    const updated = await Store.findByIdAndUpdate(req.params.id, update, { returnDocument: 'after' });
    // Flagged/removed stores hide their listings from browse (the listing
    // rows themselves did not change, but the store gate did).
    invalidateListingsCache();
    emit({
      actor: adminActor(req),
      action: 'store.moderate',
      resource: 'store',
      resourceId: String(req.params.id),
      result: 'success',
      metadata: { moderationStatus: action },
    });
    const payload = typeof updated.toObject === 'function' ? updated.toObject() : { ...updated };
    delete payload.ownerTokenHash;
    res.json({ success: true, store: payload });
  } catch (err) {
    return next(err);
  }
};

// ─── Admin: Suspend store ────────────────────────────────────────────────────
exports.suspendStore = async (req, res, next) => {
  try {
    const store = await Store.findByIdAndUpdate(req.params.id, { status: 'suspended' }, { returnDocument: 'after' });
    if (!store) return res.status(404).json({ success: false, error: 'Store not found' });
    // Suspension hides the store's listings from browse within the gate.
    invalidateListingsCache();

    emit({
      actor: adminActor(req),
      action: 'store.suspended',
      resource: 'store',
      resourceId: String(req.params.id),
      result: 'success',
    });
    const payload = typeof store.toObject === 'function' ? store.toObject() : { ...store };
    delete payload.ownerTokenHash;
    res.json({ success: true, store: payload });
  } catch (err) {
    return next(err);
  }
};
