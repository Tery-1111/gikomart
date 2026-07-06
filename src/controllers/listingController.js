const Listing = require('../models/Listing');
const { broadcastListing } = require('../services/whatsappService');
// Create listing
exports.createListing = async (req, res) => {
  try {
    const listing = await Listing.create(req.body);
    // Trigger WhatsApp broadcast
    broadcastListing(listing).catch(err =>
      console.error('Broadcast failed:', err.message)
    );
    res.status(201).json({ success: true, listing });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
};
// Get all listings
exports.getListings = async (req, res) => {
  try {
    const { category, condition, search } = req.query;

    // Lazily expire boosts whose featuredUntil has passed.
    // Self-healing: no cron needed, runs on every read.
    await Listing.updateMany(
      { featured: true, featuredUntil: { $ne: null, $lt: new Date() } },
      { $set: { featured: false, boostType: null } }
    );

    let filter = { status: 'active' };
    if (category) filter.category = category;
    if (condition) filter.condition = condition;
    if (search) filter.title = { $regex: search, $options: 'i' };

    // Featured listings sorted to top, newest first within each group
    const listings = await Listing.find(filter).sort({ featured: -1, createdAt: -1 });
    res.json({ success: true, count: listings.length, listings });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};
// Get single listing
exports.getListing = async (req, res) => {
  try {
    const listing = await Listing.findByIdAndUpdate(
      req.params.id,
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
exports.updateListing = async (req, res) => {
  try {
    const listing = await Listing.findByIdAndUpdate(req.params.id, req.body, { returnDocument: 'after' });
    if (!listing) return res.status(404).json({ success: false, error: 'Listing not found' });
    res.json({ success: true, listing });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};
// Delete listing
exports.deleteListing = async (req, res) => {
  try {
    await Listing.findByIdAndUpdate(req.params.id, { status: 'deleted' });
    res.json({ success: true, message: 'Listing deleted' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};