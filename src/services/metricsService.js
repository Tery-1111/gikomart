/**
 * Admin metrics — counts and sums only, never personal data.
 *
 * The models are passed in (rather than required here) so the caller decides
 * which connection they come from and tests can inject fakes. `now` is a
 * parameter so the time windows are deterministic under test.
 *
 * Revenue is the sum of `Payment.amount` for completed payments, bucketed by
 * `createdAt`. The schema has no currency field, so the amount is labelled KSh
 * (the site's prices are in Kenyan Shillings).
 */

// Coerce anything (numeric string, null, undefined, NaN) to a finite number.
function num(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
}

async function computeMetrics(models, now = new Date()) {
  const since24 = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const since7 = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const since30 = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  const [
    activeListings,
    flaggedListings,
    activeStores,
    flaggedStores,
    suspendedStores,
    pendingPayments,
    completed24h,
    failed24h,
    revenueRows,
    openReports,
    totalBlocks,
  ] = await Promise.all([
    models.Listing.countDocuments({ status: 'active', moderationStatus: 'approved', expiresAt: { $gt: now } }),
    models.Listing.countDocuments({ moderationStatus: 'flagged' }),
    models.Store.countDocuments({ status: 'active', expires_at: { $gt: now } }),
    models.Store.countDocuments({ moderationStatus: 'flagged' }),
    models.Store.countDocuments({ status: 'suspended' }),
    models.Payment.countDocuments({ status: 'pending' }),
    models.Payment.countDocuments({ status: 'completed', createdAt: { $gte: since24 } }),
    models.Payment.countDocuments({ status: 'failed', createdAt: { $gte: since24 } }),
    models.Payment.aggregate([
      { $match: { status: 'completed', createdAt: { $gte: since30 } } },
      {
        $group: {
          _id: '$type',
          last24h: { $sum: { $cond: [{ $gte: ['$createdAt', since24] }, '$amount', 0] } },
          last7d: { $sum: { $cond: [{ $gte: ['$createdAt', since7] }, '$amount', 0] } },
          last30d: { $sum: '$amount' },
        },
      },
    ]),
    models.Report.countDocuments({ status: 'open' }),
    models.BlockedContact.countDocuments({}),
  ]);

  const byType30d = { listing: 0, boost: 0, store: 0 };
  let last24h = 0;
  let last7d = 0;
  let last30d = 0;

  for (const row of Array.isArray(revenueRows) ? revenueRows : []) {
    const type = row && row._id;
    // Only the three known payment types count; any other grouped row is ignored.
    if (type !== 'listing' && type !== 'boost' && type !== 'store') continue;
    byType30d[type] = num(row.last30d);
    last24h += num(row.last24h);
    last7d += num(row.last7d);
    last30d += num(row.last30d);
  }

  return {
    generatedAt: now.toISOString(),
    listings: { active: num(activeListings), flagged: num(flaggedListings) },
    stores: { active: num(activeStores), flagged: num(flaggedStores), suspended: num(suspendedStores) },
    payments: { pending: num(pendingPayments), completed24h: num(completed24h), failed24h: num(failed24h) },
    revenue: {
      currency: 'KSh',
      last24h,
      last7d,
      last30d,
      byType30d,
    },
    reports: { open: num(openReports) },
    blocks: { total: num(totalBlocks) },
  };
}

module.exports = { computeMetrics };
