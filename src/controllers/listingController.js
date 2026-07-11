const Listing = require('../models/Listing');
const cloudinary = require('../config/cloudinary');

// Get all listings (paginated, high default limit so current usage is unaffected)
exports.getListings = async (req, res) => {
  try {
    const { category, condition, search, page = 1, limit = 500 } = req.query;
    await Listing.updateMany(
      { featured: true, featuredUntil: { $ne: null, $lt: new Date() } },
      { $set: { featured: false, boostType: null } }
    );
    let filter = { status: 'active' };
    if (category) filter.category = category;
    if (condition) filter.condition = condition;
    if (search) filter.title = { $regex: search, $options: 'i' };
    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(500, Math.max(1, parseInt(limit)));
    const skip = (pageNum - 1) * limitNum;
    const [listings, total] = await Promise.all([
      Listing.find(filter).sort({ featured: -1, createdAt: -1 }).skip(skip).limit(limitNum),
      Listing.countDocuments(filter),
    ]);
    res.json({
      success: true,
      count: listings.length,
      total,
      page: pageNum,
      totalPages: Math.ceil(total / limitNum),
      listings,
    });
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

// Delete listing — hard delete (no archiving). Removes Cloudinary images first, then the DB record.
exports.deleteListing = async (req, res) => {
  try {
    const listing = await Listing.findById(req.params.id);
    if (!listing) return res.status(404).json({ success: false, error: 'Listing not found' });

    if (listing.images && listing.images.length > 0) {
      for (const imageUrl of listing.images) {
        const match = imageUrl.match(/\/upload\/(?:v\d+\/)?(.+)\.\w+$/);
        if (match) {
          try {
            await cloudinary.uploader.destroy(match[1]);
          } catch (err) {
            console.warn('Failed to delete Cloudinary image:', err.message);
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