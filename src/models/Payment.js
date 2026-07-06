const mongoose = require('mongoose');

const paymentSchema = new mongoose.Schema({
  listingId: { type: mongoose.Schema.Types.ObjectId, ref: 'Listing', required: true },
  phoneNumber: { type: String, required: true },
  amount: { type: Number, required: true },
  boostType: { type: String, enum: ['featured', 'rush', 'priority_broadcast'], required: true },
  invoiceId: { type: String },
  status: { type: String, enum: ['pending', 'completed', 'failed'], default: 'pending' },
}, { timestamps: true });

module.exports = mongoose.model('Payment', paymentSchema);