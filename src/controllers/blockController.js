const mongoose = require('mongoose');
const BlockedContact = require('../models/BlockedContact');
const Listing = require('../models/Listing');
const Store = require('../models/Store');
const { emit, adminActor } = require('../services/auditService');
const { normalizeContactNumber, contactHash } = require('../utils/phone');

const VALID_SOURCE_TYPES = ['listing', 'store', 'phone'];
const MAX_REASON_LENGTH = 200;

// The same ObjectId check used by the contact-release path: a 24-hex string.
function isValidObjectId(value) {
  return typeof value === 'string' && mongoose.isValidObjectId(value) && /^[0-9a-fA-F]{24}$/.test(value);
}

// POST /api/admin/blocks — block the contacts behind a listing, a store, or a
// raw phone number. The response never contains the number or the hash.
exports.addBlock = async (req, res, next) => {
  try {
    const { sourceType, reason, sourceId, phone } = req.body || {};

    const trimmedReason = typeof reason === 'string' ? reason.trim() : '';
    if (!VALID_SOURCE_TYPES.includes(sourceType)
      || trimmedReason.length < 1
      || trimmedReason.length > MAX_REASON_LENGTH) {
      return res.status(400).json({ success: false, error: 'Invalid block request' });
    }

    let numbers;
    if (sourceType === 'phone') {
      if (normalizeContactNumber(phone) === null) {
        return res.status(400).json({ success: false, error: 'Contact number is not a valid Kenyan number' });
      }
      numbers = [phone];
    } else if (sourceType === 'listing') {
      if (!isValidObjectId(sourceId)) {
        return res.status(400).json({ success: false, error: 'Invalid block request' });
      }
      const listing = await Listing.findOne({ _id: sourceId });
      if (!listing) {
        return res.status(404).json({ success: false, error: 'Listing not found' });
      }
      numbers = [listing.sellerWhatsapp];
    } else {
      if (!isValidObjectId(sourceId)) {
        return res.status(400).json({ success: false, error: 'Invalid block request' });
      }
      const store = await Store.findOne({ _id: sourceId });
      if (!store) {
        return res.status(404).json({ success: false, error: 'Store not found' });
      }
      numbers = [store.phone, store.whatsapp];
    }

    const hashes = [...new Set(numbers.map(contactHash).filter((hash) => hash !== null))];
    if (hashes.length === 0) {
      return res.status(400).json({ success: false, error: 'No valid contact number on record for that target' });
    }

    let created = 0;
    let alreadyBlocked = 0;
    let firstCreatedId = '';
    for (const hash of hashes) {
      const existing = await BlockedContact.findOne({ contactHash: hash });
      if (existing) {
        alreadyBlocked++;
      } else {
        const doc = await BlockedContact.create({
          contactHash: hash,
          sourceType,
          sourceId: sourceId || null,
          reason: trimmedReason,
          createdBy: adminActor(req),
        });
        if (!firstCreatedId) firstCreatedId = String(doc._id);
        created++;
      }
    }

    emit({
      actor: adminActor(req),
      action: 'admin.block_added',
      resource: 'block',
      resourceId: firstCreatedId || '',
      result: 'success',
      metadata: { sourceType, sourceId: sourceId || null, created, alreadyBlocked },
    });

    res.status(created > 0 ? 201 : 200).json({ success: true, created, alreadyBlocked });
  } catch (err) {
    return next(err);
  }
};

// GET /api/admin/blocks — newest first, capped at 50. Never returns contactHash.
exports.listBlocks = async (req, res, next) => {
  try {
    const rawLimit = Number.parseInt(req.query.limit, 10) || 50;
    const limit = Math.min(Math.max(rawLimit, 1), 50);
    const blocks = await BlockedContact.find({}).sort({ createdAt: -1 }).limit(limit).lean();
    res.json({
      success: true,
      count: blocks.length,
      blocks: blocks.map((block) => ({
        id: String(block._id),
        sourceType: block.sourceType,
        sourceId: block.sourceId ?? null,
        reason: block.reason,
        createdBy: block.createdBy,
        createdAt: block.createdAt,
      })),
    });
  } catch (err) {
    return next(err);
  }
};

// DELETE /api/admin/blocks/:id — remove one block.
exports.removeBlock = async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id)) {
      return res.status(404).json({ success: false, error: 'Block not found' });
    }
    const removed = await BlockedContact.findByIdAndDelete(id);
    if (!removed) {
      return res.status(404).json({ success: false, error: 'Block not found' });
    }
    emit({
      actor: adminActor(req),
      action: 'admin.block_removed',
      resource: 'block',
      resourceId: String(id),
      result: 'success',
      metadata: {},
    });
    res.json({ success: true });
  } catch (err) {
    return next(err);
  }
};

module.exports = exports;
