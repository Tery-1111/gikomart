const crypto = require('crypto');
const mongoose = require('mongoose');
const GrantRequest = require('../models/GrantRequest');
const Store = require('../models/Store');
const BlockedContact = require('../models/BlockedContact');
const logger = require('../config/logger');
const { emit, adminActor, ownerActor } = require('../services/auditService');
const { LISTING_PRICES, STORE_PLANS } = require('../services/paymentService');
const { broadcastListing } = require('../services/whatsappService');
const { evaluateGrantMintVolume } = require('../services/grantMintAlert');
const { createResourceForPayment } = require('./paymentController');
const { VALID_CONDITIONS, isValidListingCategory } = require('../config/listingOptions');
const { isHttpUrl } = require('../utils/safeUrl');
const inputLimits = require('../config/inputLimits');
const { normalizeContactNumber, contactHash } = require('../utils/phone');
const { generateOwnerToken } = require('../utils/ownerToken');
const { ACCEPTANCE_TYPES } = require('../config/termsVersions');
const { validateAcceptanceToken, recordAcceptance } = require('../services/termsAcceptanceService');

// sha256 of the raw claim token. The raw token is returned exactly once to the
// requesting browser (its localStorage) and never persisted server-side.
function hashClaimToken(raw) {
  return crypto.createHash('sha256').update(String(raw)).digest('hex');
}

// Constant-time comparison of two hex digests. The digests are fixed-length, so
// a length check is the only branch; a mismatch still runs timingSafeEqual.
function safeCompare(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function isValidId(value) {
  return typeof value === 'string' && mongoose.Types.ObjectId.isValid(value);
}

// Mask a normalized phone the same way the admin grant preview does.
function maskPhone(value) {
  if (typeof value === 'string' && /^\d{9,15}$/.test(value)) {
    return value.slice(0, 4) + '***' + value.slice(-2);
  }
  return value;
}

// Validate a listing payload using the SAME shared constants the paid
// initiate-listing path uses (VALID_CONDITIONS, inputLimits, isHttpUrl).
function buildListingPayload(listingData) {
  if (!listingData || typeof listingData !== 'object') return { error: 'Missing listing details' };
  const errors = [];
  if (typeof listingData.title !== 'string' || !listingData.title.trim()) errors.push('title');
  // Canonical listing-category stable ID — same contract as the paid path.
  if (!isValidListingCategory(listingData.category)) errors.push('category');
  if (!VALID_CONDITIONS.includes(listingData.condition)) errors.push('condition');
  if (listingData.images !== undefined
    && (!Array.isArray(listingData.images) || !listingData.images.every(isHttpUrl))) errors.push('images');
  const price = Number(listingData.price);
  if (!Number.isFinite(price) || price < 0) errors.push('price');
  if (typeof listingData.description !== 'string' || !listingData.description.trim()) errors.push('description');
  if (typeof listingData.sellerName !== 'string' || !listingData.sellerName.trim()) errors.push('sellerName');
  if (typeof listingData.sellerWhatsapp !== 'string' || !listingData.sellerWhatsapp.trim()) errors.push('sellerWhatsapp');
  const caps = inputLimits.listing;
  for (const [field, cap] of Object.entries(caps)) {
    if (typeof cap !== 'number') continue;
    const value = listingData[field];
    if (typeof value === 'string' && value.trim().length > cap) errors.push(field);
  }
  if (Array.isArray(listingData.images) && listingData.images.length > caps.images.maxItems) errors.push('images');
  if (errors.length > 0) return { error: `Invalid or missing listing details: ${errors.join(', ')}` };
  return { listingData: { ...listingData, price } };
}

// Validate a store payload and derive a unique slug, mirroring the paid
// initiate-store-plan path (same inputLimits and slug convention).
async function buildStorePayload(storeData) {
  if (!storeData || typeof storeData !== 'object') return { error: 'Missing store details' };
  const errors = [];
  if (typeof storeData.name !== 'string' || !storeData.name.trim()) errors.push('name');
  if (typeof storeData.category !== 'string' || !storeData.category.trim()) errors.push('category');
  if (typeof storeData.phone !== 'string' || !storeData.phone.trim()) errors.push('phone');
  if (typeof storeData.whatsapp !== 'string' || !storeData.whatsapp.trim()) errors.push('whatsapp');
  const caps = inputLimits.store;
  for (const [field, cap] of Object.entries(caps)) {
    if (typeof cap !== 'number') continue;
    const value = storeData[field];
    if (typeof value === 'string' && value.trim().length > cap) errors.push(field);
  }
  for (const [field, cfg] of [['subcategories', caps.subcategories], ['payment_methods', caps.payment_methods]]) {
    const value = storeData[field];
    if (Array.isArray(value)) {
      if (value.length > cfg.maxItems
        || value.some((item) => typeof item === 'string' && item.trim().length > cfg.item)) errors.push(field);
    }
  }
  if (errors.length > 0) return { error: `Invalid or missing store details: ${errors.join(', ')}` };
  const base = storeData.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'store';
  let slug = base;
  let counter = 2;
  while (await Store.findOne({ slug })) {
    slug = `${base}-${counter}`;
    counter += 1;
  }
  return { storeData: { ...storeData, slug } };
}

// ─── Public: submit a free-grant request ────────────────────────────────────
exports.submitGrant = async (req, res, next) => {
  try {
    const body = req.body || {};
    const type = body.type;
    if (type !== 'listing' && type !== 'store') {
      return res.status(400).json({ success: false, error: 'Invalid grant type' });
    }

    const normalized = normalizeContactNumber(body.whatsapp);
    if (!normalized) {
      return res.status(400).json({ success: false, error: 'Enter a valid WhatsApp number' });
    }

    const pkg = typeof body.package === 'string' ? body.package.trim() : '';
    const plan = typeof body.storePlan === 'string' ? body.storePlan.trim() : '';
    if (type === 'listing' && !LISTING_PRICES[pkg]) {
      return res.status(400).json({ success: false, error: 'Invalid listing package' });
    }
    if (type === 'store' && !STORE_PLANS[plan]) {
      return res.status(400).json({ success: false, error: 'Invalid store plan' });
    }

    // Blocked contacts cannot request a grant (same rule as payment initiation).
    const blocked = await BlockedContact.findOne({ contactHash: contactHash(normalized) });
    if (blocked) {
      emit({
        actor: ownerActor(req),
        action: 'grant.blocked_contact',
        resource: 'grant',
        result: 'failure',
        metadata: { route: 'grants' },
      });
      return res.status(403).json({ success: false, error: 'This number cannot be used on GikoMart' });
    }

    const rawClaimToken = crypto.randomBytes(24).toString('hex');
    const grant = await GrantRequest.create({
      whatsapp: normalized,
      contactHash: contactHash(normalized),
      claimTokenHash: hashClaimToken(rawClaimToken),
      type,
      package: type === 'listing' ? pkg : null,
      storePlan: type === 'store' ? plan : null,
      status: 'pending',
    });

    emit({
      actor: ownerActor(req),
      action: 'grant.requested',
      resource: 'grant',
      resourceId: String(grant._id),
      result: 'success',
      metadata: { type, package: grant.package || null, storePlan: grant.storePlan || null },
    });

    return res.status(201).json({
      success: true,
      message: 'Request submitted. The GikoMart admin will review it and contact you on WhatsApp.',
      claimId: String(grant._id),
      claimToken: rawClaimToken,
      status: 'pending',
      type,
    });
  } catch (err) {
    logger.error('Grant request error', { error: err.message });
    return next(err);
  }
};

// ─── Public: poll the status of a request (claim token required) ────────────
exports.getGrantStatus = async (req, res, next) => {
  try {
    const raw = req.get('X-Grant-Token');
    if (!raw) return res.status(401).json({ success: false, error: 'Grant token required' });
    if (!isValidId(req.params.claimId)) {
      return res.status(404).json({ success: false, error: 'Grant request not found' });
    }

    const grant = await GrantRequest.findById(req.params.claimId);
    if (!grant) return res.status(404).json({ success: false, error: 'Grant request not found' });
    if (!safeCompare(grant.claimTokenHash, hashClaimToken(raw))) {
      return res.status(401).json({ success: false, error: 'Invalid grant token' });
    }

    const resourceId = grant.type === 'listing' ? grant.listingId : grant.storeId;
    return res.json({
      success: true,
      status: grant.status,
      type: grant.type,
      provisioned: Boolean(grant.provisionedAt),
      resourceId: resourceId ? String(resourceId) : null,
    });
  } catch (err) {
    return next(err);
  }
};

// ─── Public: redeem an approved request → existing provisioning ─────────────
exports.redeemGrant = async (req, res, next) => {
  try {
    const raw = req.get('X-Grant-Token');
    if (!raw) return res.status(401).json({ success: false, error: 'Grant token required' });
    if (!isValidId(req.params.claimId)) {
      return res.status(404).json({ success: false, error: 'Grant request not found' });
    }

    const grant = await GrantRequest.findById(req.params.claimId);
    if (!grant) return res.status(404).json({ success: false, error: 'Grant request not found' });
    if (!safeCompare(grant.claimTokenHash, hashClaimToken(raw))) {
      return res.status(401).json({ success: false, error: 'Invalid grant token' });
    }

    if (grant.status === 'rejected') {
      return res.status(409).json({ success: false, error: 'This grant request was rejected' });
    }

    // Idempotent replay: already provisioned → return the existing resource
    // rather than creating a second one. The epoch-0 sentinel (a redemption
    // currently in flight) is excluded so a mid-flight race never reports a
    // not-yet-existing resource as "already provisioned".
    if (grant.provisionedAt && grant.provisionedAt.getTime() > 0) {
      const existingId = grant.type === 'listing' ? grant.listingId : grant.storeId;
      return res.status(200).json({
        success: true,
        alreadyProvisioned: true,
        resource: { type: grant.type, id: existingId ? String(existingId) : null },
      });
    }

    if (grant.status !== 'approved') {
      return res.status(409).json({ success: false, error: 'This grant request has not been approved yet' });
    }

    // Atomic single-winner claim. Two concurrent redeems both pass the reads
    // above, so the resource-producing side must be claimed atomically: only
    // the request whose update matches `provisionedAt: null` may mint an owner
    // token and provision. The epoch-0 sentinel marks "claimed, provisioning";
    // it is replaced by the real timestamp on success and reset to null on
    // failure, preserving the documented safe-retry behaviour.
    const claimed = await GrantRequest.findOneAndUpdate(
      { _id: grant._id, status: 'approved', provisionedAt: null },
      { $set: { provisionedAt: new Date(0) } },
      { returnDocument: 'after' },
    );
    if (!claimed) {
      // Another request holds the claim. Resolve to its outcome instead of
      // minting a second (potentially dead) owner token.
      const fresh = await GrantRequest.findById(grant._id);
      if (fresh && fresh.provisionedAt && fresh.provisionedAt.getTime() > 0) {
        const existingId = fresh.type === 'listing' ? fresh.listingId : fresh.storeId;
        return res.status(200).json({
          success: true,
          alreadyProvisioned: true,
          resource: { type: fresh.type, id: existingId ? String(existingId) : null },
        });
      }
      return res.status(409).json({ success: false, error: 'This grant is being redeemed right now — try again in a moment' });
    }

    // Validate the payload + terms using the same rules the paid path enforces.
    const acceptance = req.body && req.body.acceptance;
    let payload;
    let acceptanceType;
    if (grant.type === 'listing') {
      const built = buildListingPayload(req.body && req.body.listingData);
      if (built.error) return res.status(400).json({ success: false, error: built.error });
      acceptanceType = ACCEPTANCE_TYPES.LISTING_PUBLICATION;
      const av = validateAcceptanceToken(acceptance, acceptanceType);
      if (!av.valid) return res.status(400).json({ success: false, error: `Terms acceptance required: ${av.error}` });
      payload = { listingData: built.listingData, versions: av.versions };
    } else {
      const built = await buildStorePayload(req.body && req.body.storeData);
      if (built.error) return res.status(400).json({ success: false, error: built.error });
      acceptanceType = ACCEPTANCE_TYPES.STORE_CREATION;
      const av = validateAcceptanceToken(acceptance, acceptanceType);
      if (!av.valid) return res.status(400).json({ success: false, error: `Terms acceptance required: ${av.error}` });
      payload = { storeData: built.storeData, versions: av.versions };
    }

    // The owner token is minted in the SELLER's request (this one) — never in
    // the admin's — and returned once, exactly like the paid initiate response.
    const { rawOwnerToken, ownerTokenHash } = generateOwnerToken();

    const contactWhatsapp = grant.type === 'listing' ? payload.listingData.sellerWhatsapp : payload.storeData.whatsapp;

    // Payment-shaped object for the shared provisioning convergence point. It
    // needs no real Payment document: createResourceForPayment reads only these
    // fields, and uses `_id` as the unique-sparse `paymentId` on the resource.
    const paymentShaped = grant.type === 'listing'
      ? { _id: grant._id, type: 'listing', package: grant.package, listingData: payload.listingData, ownerTokenHash }
      : { _id: grant._id, type: 'store', storePlan: grant.storePlan, storeData: payload.storeData, ownerTokenHash };

    // Acceptance + provisioning run inside the claim. Any failure releases the
    // claim (provisionedAt back to null) so the seller can safely retry.
    let result;
    try {
      await recordAcceptance({
        acceptanceType,
        versions: payload.versions,
        action: grant.type === 'listing' ? `FREE_GRANT_PUBLISH:${grant.package}` : `FREE_GRANT_CREATE_STORE:${grant.storePlan}`,
        phone: grant.whatsapp,
        whatsapp: contactWhatsapp,
        ownerTokenHash,
        ip: req.ip,
        userAgent: req.get('user-agent') || '',
        fee: { amount: 0, currency: 'KES', label: 'Free grant' },
        metadata: {
          grantRequestId: String(grant._id),
          grantPackage: grant.package || null,
          grantStorePlan: grant.storePlan || null,
        },
      });

      result = await createResourceForPayment(paymentShaped);
    } catch (err) {
      claimed.provisionedAt = null;
      await claimed.save().catch(() => {});
      throw err;
    }
    const { type, doc } = result;

    claimed.provisionedAt = new Date();
    if (type === 'listing') claimed.listingId = doc._id;
    else claimed.storeId = doc._id;
    await claimed.save();

    emit({
      actor: ownerActor(req),
      action: 'grant.redeemed',
      resource: type === 'store' ? 'Store' : 'Listing',
      resourceId: String(doc._id),
      result: 'success',
      metadata: {
        grantRequestId: String(grant._id),
        type,
        package: grant.package || null,
        storePlan: grant.storePlan || null,
      },
    });

    // Broadcast parity with the paid listing path (paymentController webhook):
    // announce the new listing, but only when moderation approved it — the paid
    // path skips flagged listings too. Fire-and-forget: a broadcast failure
    // must never turn a completed provisioning into a failed redemption.
    // Store grants have no broadcast mechanism to reuse, so none is triggered.
    if (type === 'listing' && doc.moderationStatus === 'approved') {
      broadcastListing(doc).catch((broadcastErr) => {
        logger.warn('Grant listing broadcast failed', { error: broadcastErr.message });
      });
    }

    return res.status(201).json({
      success: true,
      resource: { type, id: String(doc._id) },
      ownerToken: rawOwnerToken,
    });
  } catch (err) {
    logger.error('Grant redeem error', { error: err.message });
    return next(err);
  }
};

// ─── Admin: mint a NEW continuation credential for an approved grant ───────
// The claim token lives only in the seller's browser localStorage. When it is
// lost before redemption (cleared storage, new phone), the admin can
// deliberately rotate the credential: the stored claimTokenHash is atomically
// replaced with the hash of a freshly generated 192-bit token. Reusing the
// SAME field means there is still exactly one credential system and the old
// token is revoked by the write itself; timing-safe comparison is untouched.
// The raw token is returned ONLY in this action's response — the list endpoint
// never carries a token or hash — and it is never logged or audited in
// plaintext.
exports.mintGrantContinuation = async (req, res) => {
  if (!isValidId(req.params.id)) {
    return res.status(400).json({ success: false, error: 'Invalid grant id' });
  }
  try {
    // Eligibility mirrors redemption itself: approved and not yet provisioned
    // (the epoch-0 in-flight sentinel also fails the provisionedAt:null match,
    // so a rotation can never strand a redemption that is mid-flight). There
    // is no second credential system: this replaces claimTokenHash in place.
    const rawToken = crypto.randomBytes(24).toString('hex');
    const grant = await GrantRequest.findOneAndUpdate(
      { _id: req.params.id, status: 'approved', provisionedAt: null },
      { $set: { claimTokenHash: hashClaimToken(rawToken) } },
      { returnDocument: 'after' },
    );
    if (!grant) {
      // Distinguish "no such grant" (404) from "wrong state" (409) so the
      // admin can tell a typo from an eligibility problem.
      const exists = await GrantRequest.findById(req.params.id);
      if (!exists) return res.status(404).json({ success: false, error: 'Grant request not found' });
      return res.status(409).json({ success: false, error: 'Only approved, not-yet-provisioned grants can get a continuation token' });
    }

    // Audit the rotation without the token or its hash in any field.
    emit({
      actor: adminActor(req),
      action: 'admin.grant_continuation_minted',
      resource: 'grant',
      resourceId: String(grant._id),
      result: 'success',
      metadata: { type: grant.type },
    });

    // Lightweight abuse alarm: flag unusual minting volume. The audit trail
    // written above is the evidence base, so this evaluation is
    // fire-and-forget — an alert must never delay or fail the mint response,
    // and the raw token is irrelevant (and invisible) to it.
    evaluateGrantMintVolume().catch(() => {});

    return res.json({
      success: true,
      claimId: String(grant._id),
      claimToken: rawToken,
      message: 'New continuation token generated. The previous token no longer works. Send it to the seller now — it is shown only once.',
    });
  } catch (err) {
    logger.error('Grant continuation mint error', { error: err.message });
    res.status(500).json({ success: false, error: 'Failed to generate continuation token' });
  }
};

// ─── Admin: list requests ───────────────────────────────────────────────────
exports.listGrantRequests = async (req, res) => {
  try {
    const status = ['pending', 'approved', 'rejected'].includes(req.query.status)
      ? req.query.status
      : 'pending';
    // Optional QA filter: ?isTest=true|false narrows the view to test
    // requests (or excludes them). Absent → no filtering (existing behavior).
    const isTestFilter = req.query.isTest === 'true' ? true
      : req.query.isTest === 'false' ? false
      : undefined;
    const grants = await GrantRequest.find(isTestFilter === undefined ? { status } : { status, isTest: isTestFilter })
      .sort({ createdAt: -1 }).limit(50).lean();

    emit({
      actor: adminActor(req),
      action: 'admin.grant_requests_viewed',
      resource: 'admin',
      result: 'success',
      metadata: { count: grants.length, status },
    });

    res.json({
      success: true,
      count: grants.length,
      requests: grants.map((grant) => ({
        id: String(grant._id),
        type: grant.type,
        package: grant.package || null,
        storePlan: grant.storePlan || null,
        status: grant.status,
        isTest: Boolean(grant.isTest),
        createdAt: grant.createdAt,
        decidedAt: grant.decidedAt || null,
        provisioned: Boolean(grant.provisionedAt && grant.provisionedAt.getTime() > 0),
        // Full number for the session-gated admin queue (wa.me contact +
        // verification). Never returned by any public endpoint; the masked
        // form is kept for any surface that prefers it.
        whatsapp: grant.whatsapp,
        whatsappMasked: maskPhone(grant.whatsapp),
      })),
    });
  } catch (err) {
    logger.error('Grant list error', { error: err.message });
    res.status(500).json({ success: false, error: 'Failed to list grant requests' });
  }
};

// ─── Admin: approve (atomic pending → approved, terminal — no unapprove path) ─
// Terminal by design: docs/DECISIONS.md record #36 holds the atomicity, audit
// and abuse rationale. The cosmetic QA flag (setGrantTestFlag below) is the
// only post-decision lever that does not touch the decision itself.
exports.approveGrant = async (req, res) => {
  if (!isValidId(req.params.id)) {
    return res.status(400).json({ success: false, error: 'Invalid grant id' });
  }
  try {
    const decidedAt = new Date();
    const grant = await GrantRequest.findOneAndUpdate(
      { _id: req.params.id, status: 'pending' },
      { $set: { status: 'approved', decidedBy: adminActor(req), decidedAt } },
      { returnDocument: 'after' },
    );
    if (!grant) {
      return res.status(404).json({ success: false, error: 'No pending grant request found' });
    }

    emit({
      actor: adminActor(req),
      action: 'admin.grant_approved',
      resource: 'grant',
      resourceId: String(grant._id),
      result: 'success',
      metadata: { type: grant.type, package: grant.package || null, storePlan: grant.storePlan || null },
    });

    res.json({ success: true, message: 'Grant approved', grantId: String(grant._id), status: 'approved' });
  } catch (err) {
    logger.error('Grant approve error', { error: err.message });
    res.status(500).json({ success: false, error: 'Grant approval failed' });
  }
};

// ─── Admin: QA flag (marks an agent-submitted test request) ────────────────
// The queue serves real sellers, so test requests must be visually separable.
// This only toggles the marker — the decision lifecycle is untouched, so the
// flag is available for any status (not just pending) and can be corrected at
// any time. Unrecognized bodies are ignored (no upsert, no error).
exports.setGrantTestFlag = async (req, res) => {
  if (!isValidId(req.params.id)) {
    return res.status(400).json({ success: false, error: 'Invalid grant id' });
  }
  try {
    const grant = await GrantRequest.findOneAndUpdate(
      { _id: req.params.id },
      { $set: { isTest: Boolean(req.body && req.body.isTest) } },
      { returnDocument: 'after' },
    );
    if (!grant) {
      return res.status(404).json({ success: false, error: 'Grant request not found' });
    }

    emit({
      actor: adminActor(req),
      action: 'admin.grant_test_flag_set',
      resource: 'grant',
      resourceId: String(grant._id),
      result: 'success',
      metadata: { isTest: grant.isTest },
    });

    res.json({ success: true, grantId: String(grant._id), isTest: grant.isTest });
  } catch (err) {
    logger.error('Grant test-flag error', { error: err.message });
    res.status(500).json({ success: false, error: 'Failed to set the test flag' });
  }
};

// ─── Admin: reject (atomic pending → rejected, terminal) ────────────────────
exports.rejectGrant = async (req, res) => {
  if (!isValidId(req.params.id)) {
    return res.status(400).json({ success: false, error: 'Invalid grant id' });
  }
  try {
    const decidedAt = new Date();
    const grant = await GrantRequest.findOneAndUpdate(
      { _id: req.params.id, status: 'pending' },
      { $set: { status: 'rejected', decidedBy: adminActor(req), decidedAt } },
      { returnDocument: 'after' },
    );
    if (!grant) {
      return res.status(404).json({ success: false, error: 'No pending grant request found' });
    }

    emit({
      actor: adminActor(req),
      action: 'admin.grant_rejected',
      resource: 'grant',
      resourceId: String(grant._id),
      result: 'success',
      metadata: { type: grant.type },
    });

    res.json({ success: true, message: 'Grant rejected', grantId: String(grant._id), status: 'rejected' });
  } catch (err) {
    logger.error('Grant reject error', { error: err.message });
    res.status(500).json({ success: false, error: 'Grant rejection failed' });
  }
};
