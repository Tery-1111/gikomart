const mongoose = require('mongoose');

const paymentSchema = new mongoose.Schema({
  type: { type: String, enum: ['listing', 'boost'], required: true },
  listingId: { type: mongoose.Schema.Types.ObjectId, ref: 'Listing' }, // absent until listing payment completes
  listingData: { type: mongoose.Schema.Types.Mixed }, // pending sell-form payload, used only for type:'listing'
  package: { type: String, enum: ['quick', 'standard', 'premium'] }, // used only for type:'listing'
  phoneNumber: { type: String, required: true },
  amount: { type: Number, required: true },
  boostType: { type: String, enum: ['featured', 'rush', 'priority_broadcast'] }, // used only for type:'boost'
  invoiceId: { type: String },
  status: { type: String, enum: ['pending', 'completed', 'failed'], default: 'pending' },
}, { timestamps: true });

module.exports = mongoose.model('Payment', paymentSchema);