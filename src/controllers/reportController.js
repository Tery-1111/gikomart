const mongoose = require('mongoose');
const Report = require('../models/Report');
const Listing = require('../models/Listing');
const Store = require('../models/Store');
const { emit, adminActor } = require('../services/auditService');
const inputLimits = require('../config/inputLimits');

const TARGET_TYPES = ['listing', 'store'];
const REASONS = ['scam', 'prohibited_item', 'wrong_info', 'harassment', 'other'];
const STATUSES = ['open', 'actioned', 'dismissed', 'all'];
const RESOLUTIONS = ['actioned', 'dismissed'];
const MODERATION_ACTIONS = ['none', 'approved', 'flagged', 'removed', 'suspended'];
const DEDUPE_WINDOW_MS = 24 * 60 * 60 * 1000;
const LIST_LIMIT = 50;

// The same ObjectId check used by the anonymous-store gate in getListings: a
// 24-hex string. A non-string or a bad shape is treated as "not found".
function isValidObjectId(value) {
  return typeof value === 'string' && mongoose.isValidObjectId(value) && /^[0-9a-fA-F]{24}$/.test(value);
}

// POST /api/reports — record a user report against a live listing or store. The
// reporter IP is stored only to deduplicate repeats and is never echoed back.
exports.submitReport = async (req, res, next) => {
  try {
    const {
      targetType, targetId, reason, details,
    } = req.body || {};

    if (!TARGET_TYPES.includes(targetType) || !REASONS.includes(reason)) {
      return res.status(400).json({ success: false, error: 'Invalid report' });
    }
    if (details !== undefined
      && (typeof details !== 'string' || details.trim().length > inputLimits.report.details)) {
      return res.status(400).json({ success: false, error: 'Invalid report' });
    }
    if (!isValidObjectId(targetId)) {
      return res.status(404).json({ success: false, error: 'Target not found' });
    }

    // Only a target that still exists and has not been removed can be reported.
    const target = targetType === 'listing'
      ? await Listing.findOne({ _id: targetId, moderationStatus: { $ne: 'removed' } })
      : await Store.findOne({ _id: targetId, moderationStatus: { $ne: 'removed' } });
    if (!target) {
      return res.status(404).json({ success: false, error: 'Target not found' });
    }

    const reporterIp = typeof req.ip === 'string' && req.ip !== '' ? req.ip : null;
    const trimmedDetails = typeof details === 'string' ? details.trim() : '';

    // One open report per IP and target within a rolling 24-hour window.
    if (reporterIp !== null) {
      const existing = await Report.findOne({
        targetType,
        targetId,
        reporterIp,
        status: 'open',
        createdAt: { $gte: new Date(Date.now() - DEDUPE_WINDOW_MS) },
      });
      if (existing) {
        return res.status(200).json({ success: true });
      }
    }

    await Report.create({
      targetType,
      targetId,
      reason,
      details: trimmedDetails,
      reporterIp,
    });
    return res.status(201).json({ success: true });
  } catch (err) {
    return next(err);
  }
};

// GET /api/admin/reports — newest first, capped at 50. The reporter IP is never
// serialized; only the operational fields are returned.
exports.listReports = async (req, res, next) => {
  try {
    const status = req.query.status === undefined ? 'open' : req.query.status;
    if (!STATUSES.includes(status)) {
      return res.status(400).json({ success: false, error: 'Invalid status' });
    }
    const { targetType } = req.query;
    if (targetType !== undefined && !TARGET_TYPES.includes(targetType)) {
      return res.status(400).json({ success: false, error: 'Invalid targetType' });
    }

    const rawLimit = Number.parseInt(req.query.limit, 10) || LIST_LIMIT;
    const limit = Math.min(Math.max(rawLimit, 1), LIST_LIMIT);

    const filter = {};
    if (status !== 'all') filter.status = status;
    if (targetType !== undefined) filter.targetType = targetType;
    const parsedBefore = req.query.before === undefined ? null : new Date(req.query.before);
    if (parsedBefore && !Number.isNaN(parsedBefore.getTime())) {
      filter.createdAt = { $lt: parsedBefore };
    }

    const reports = await Report.find(filter).sort({ createdAt: -1 }).limit(limit).lean();
    res.json({
      success: true,
      count: reports.length,
      reports: reports.map((report) => ({
        id: String(report._id),
        targetType: report.targetType,
        targetId: report.targetId,
        reason: report.reason,
        details: report.details,
        status: report.status,
        moderationAction: report.moderationAction ?? null,
        resolvedAt: report.resolvedAt ?? null,
        resolvedBy: report.resolvedBy ?? null,
        note: report.note,
        createdAt: report.createdAt,
      })),
    });
  } catch (err) {
    return next(err);
  }
};

// PUT /api/admin/reports/:id/resolve — close an open report. This records the
// moderation action an admin took through the moderation endpoints; it does NOT
// apply any moderation itself.
exports.resolveReport = async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!isValidObjectId(id)) {
      return res.status(404).json({ success: false, error: 'Report not found' });
    }
    const report = await Report.findById(id);
    if (!report) {
      return res.status(404).json({ success: false, error: 'Report not found' });
    }
    if (report.status !== 'open') {
      return res.status(409).json({ success: false, error: 'Report already resolved' });
    }

    const { resolution, moderationAction, note } = req.body || {};
    if (!RESOLUTIONS.includes(resolution)) {
      return res.status(400).json({ success: false, error: 'Invalid resolution' });
    }
    if (resolution === 'dismissed') {
      if (moderationAction !== undefined && moderationAction !== 'none') {
        return res.status(400).json({ success: false, error: 'Invalid resolution' });
      }
    } else {
      if (!MODERATION_ACTIONS.includes(moderationAction)) {
        return res.status(400).json({ success: false, error: 'Invalid resolution' });
      }
      // Suspension only makes sense for a store target.
      if (moderationAction === 'suspended' && report.targetType !== 'store') {
        return res.status(400).json({ success: false, error: 'Invalid resolution' });
      }
    }
    if (note !== undefined
      && (typeof note !== 'string' || note.trim().length > inputLimits.report.note)) {
      return res.status(400).json({ success: false, error: 'Invalid resolution' });
    }

    const resolvedAction = resolution === 'dismissed' ? 'none' : (moderationAction || 'none');
    await Report.findByIdAndUpdate(id, {
      status: resolution,
      moderationAction: resolvedAction,
      resolvedAt: new Date(),
      resolvedBy: adminActor(req),
      note: typeof note === 'string' ? note.trim() : '',
    }, { returnDocument: 'after' });

    emit({
      actor: adminActor(req),
      action: 'admin.report_resolved',
      resource: 'report',
      resourceId: String(id),
      result: 'success',
      metadata: {
        targetType: report.targetType,
        targetId: report.targetId,
        resolution,
        moderationAction: resolvedAction,
      },
    });
    res.json({ success: true });
  } catch (err) {
    return next(err);
  }
};
