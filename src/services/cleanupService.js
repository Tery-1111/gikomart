const cron = require('node-cron');
const Listing = require('../models/Listing');
const Store = require('../models/Store');
const TermsAcceptance = require('../models/TermsAcceptance');
const Payment = require('../models/Payment');
const Report = require('../models/Report');
const AuditEvent = require('../models/AuditEvent');
const Upload = require('../models/Upload');
const cloudinary = require('../config/cloudinary');
const logger = require('../config/logger');

// Retention windows (days). Report IPs are kept only for deduplication; payment
// PII is kept for the dispute window and then redacted.
const REPORT_IP_RETENTION_DAYS = 30;
const PAYMENT_PII_RETENTION_DAYS = 90;

// Extract the Cloudinary public_id from a stored secure_url
// e.g. https://res.cloudinary.com/xxx/image/upload/v123/gikomart/abc.webp -> gikomart/abc
function extractPublicId(url) {
  // eslint-disable-next-line security/detect-unsafe-regex -- double-anchored, bounded-length URLs; worst case is quadratic over ~100 chars, not ReDoS
  const match = url.match(/\/upload\/(?:v\d+\/)?(.+)\.\w+$/);
  return match ? match[1] : null;
}

// Safety net: a record whose payment has not settled must not be treated as
// simply "expired" — the webhook that should have confirmed it never completed,
// so removing it would discard a paid record. Returns true when deletion/expiry
// may proceed: no paymentId (legacy/manual record), payment missing (orphaned
// reference), or payment.status === 'completed'. Any other status skips+logs.
async function paymentSettled(record, collection) {
  if (!record.paymentId) return true;
  const payment = await Payment.findById(record.paymentId);
  if (!payment) return true;
  if (payment.status === 'completed') return true;
  logger.warn('Cleanup skipped: payment not settled', {
    collection,
    id: String(record._id),
    paymentId: String(record.paymentId),
    status: payment.status,
  });
  return false;
}

async function deleteExpiredListings() {
  try {
    const expired = await Listing.find({ expiresAt: { $lte: new Date() } });

    if (!expired.length) return;

    for (const listing of expired) {
      if (!(await paymentSettled(listing, 'listings'))) continue;
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

// Orphan upload sweep: destroy Cloudinary assets that were never attached to
// a listing or store (attached:false) after 24 hours. Max 100 per run so a
// backlog cannot turn one tick into an unbounded API burst. The Upload record
// is deleted only when the Cloudinary destroy succeeded; every error is caught
// and logged so one bad asset never kills the rest of the cron step.
async function destroyOrphanUploads() {
  try {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const orphans = await Upload.find({ attached: false, createdAt: { $lt: cutoff } }).limit(100);
    if (!orphans.length) return;

    let destroyed = 0;
    let failed = 0;
    for (const orphan of orphans) {
      try {
        await cloudinary.uploader.destroy(orphan.publicId);
        await Upload.deleteOne({ _id: orphan._id });
        destroyed += 1;
      } catch (err) {
        failed += 1;
        logger.warn('Failed to destroy orphan upload', { publicId: orphan.publicId, error: err.message });
      }
    }
    logger.info('Cleanup: orphan upload sweep', { scanned: orphans.length, destroyed, failed });
  } catch (err) {
    logger.error('Orphan upload sweep error', { error: err.message });
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

// 30-day PII retention: null the two contact hashes on acceptance records older
// than 30 days. whatsappHash and sellerContactTarget.sellerWhatsappHash are
// unkeyed hashes of phone numbers and are brute-forceable over the small Kenyan
// number space, exactly like phoneHash. ownerTokenHash is kept (a long random
// token, not reversible into a person); listing/store ids and metadata are kept
// as evidence. The record itself is kept.
async function stripOldAcceptanceHashes() {
  try {
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const old = await TermsAcceptance.find({
      timestamp: { $lte: cutoff },
      $or: [
        { 'actor.whatsappHash': { $ne: null } },
        { 'sellerContactTarget.sellerWhatsappHash': { $ne: null } },
      ],
    });

    if (!old.length) return;

    for (const record of old) {
      record.actor.whatsappHash = null;
      if (record.sellerContactTarget) {
        record.sellerContactTarget.sellerWhatsappHash = null;
      }
      await record.save();
    }

    logger.info('Retention: stripped TermsAcceptance contact hashes (>30d)', { count: old.length });
  } catch (err) {
    logger.error('Acceptance hash retention job error', { error: err.message });
  }
}

// 30-day PII retention: null the reporter IP on reports older than 30 days. The
// report body is kept; the IP existed only to deduplicate repeats.
async function stripOldReportPII() {
  try {
    const cutoff = new Date(Date.now() - REPORT_IP_RETENTION_DAYS * 24 * 60 * 60 * 1000);
    const old = await Report.find({ createdAt: { $lte: cutoff }, reporterIp: { $ne: null } });

    if (!old.length) return;

    for (const record of old) {
      record.reporterIp = null;
      await record.save();
    }

    logger.info('Retention: stripped report reporter IPs (>30d)', { count: old.length });
  } catch (err) {
    logger.error('Report IP retention job error', { error: err.message });
  }
}

// 90-day PII retention: redact the payer number and the seller/store contact
// copies inside a settled payment's payload. Only completed/failed payments are
// touched — a pending payment may still be needed to complete — and
// piiStrippedAt keeps the job idempotent.
async function stripOldPaymentPII() {
  try {
    const cutoff = new Date(Date.now() - PAYMENT_PII_RETENTION_DAYS * 24 * 60 * 60 * 1000);
    const result = await Payment.updateMany(
      { status: { $in: ['completed', 'failed'] }, createdAt: { $lte: cutoff }, piiStrippedAt: null },
      {
        $set: { phoneNumber: 'redacted', piiStrippedAt: new Date() },
        $unset: {
          'listingData.sellerWhatsapp': '',
          'storeData.phone': '',
          'storeData.whatsapp': '',
          'storeData.email': '',
        },
      },
    );

    if (result.modifiedCount > 0) {
      logger.info('Retention: stripped payment PII (>90d)', { count: result.modifiedCount });
    }
  } catch (err) {
    logger.error('Payment PII retention job error', { error: err.message });
  }
}

// Audit-event retention. AUDIT_RETENTION_DAYS is read at call time so ops can
// change it without a redeploy of the logic; any value that is not a positive
// integer falls back to 365 days. Deletion is batched by MongoDB via deleteMany.
async function pruneOldAuditEvents() {
  try {
    const configuredDays = Number.parseInt(process.env.AUDIT_RETENTION_DAYS, 10);
    const days = Number.isInteger(configuredDays) && configuredDays > 0 ? configuredDays : 365;
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const result = await AuditEvent.deleteMany({ timestamp: { $lt: cutoff } });

    if (result.deletedCount > 0) {
      logger.info('Retention: pruned old audit events', { count: result.deletedCount });
    }
  } catch (err) {
    logger.error('Audit event retention job error', { error: err.message });
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
      if (!(await paymentSettled(store, 'stores'))) continue;
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
    await stripOldAcceptanceHashes();
    await stripOldReportPII();
    await stripOldPaymentPII();
    await pruneOldAuditEvents();
    await destroyOrphanUploads();
  });
  logger.info('Cleanup scheduler started (every 30 min) — listings + store expiry + retention (store/acceptance contacts and hashes, report IPs, payment PII, audit events) + orphan upload sweep');
}

module.exports = {
  startCleanupScheduler,
  deleteExpiredListings,
  expireStores,
  stripExpiredStoreContacts,
  stripOldAcceptancePII,
  stripOldAcceptanceHashes,
  stripOldReportPII,
  stripOldPaymentPII,
  pruneOldAuditEvents,
  destroyOrphanUploads,
};
