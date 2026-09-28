const mongoose = require('mongoose');

const paymentSchema = new mongoose.Schema({
  type: { type: String, enum: ['listing', 'boost', 'store'], required: true },
  listingId: { type: mongoose.Schema.Types.ObjectId, ref: 'Listing' }, // absent until listing payment completes
  listingData: { type: mongoose.Schema.Types.Mixed }, // pending sell-form payload, used only for type:'listing'
  package: { type: String, enum: ['quick', 'standard', 'premium'] }, // used only for type:'listing'
  phoneNumber: { type: String, required: true },
  amount: { type: Number, required: true },
  boostType: { type: String, enum: ['featured', 'rush', 'priority_broadcast'] }, // used only for type:'boost'
  storePlan: { type: String, enum: ['starter_weekly', 'standard_weekly', 'standard_monthly', 'pro_monthly'] }, // used only for type:'store'
  storeData: { type: mongoose.Schema.Types.Mixed }, // pending store-form payload, used only for type:'store'
  storeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Store' }, // absent until store payment completes
  invoiceId: { type: String },
  // sha256 of the raw ownership token returned ONCE in the initiate-listing
  // response. The raw token is NEVER stored server-side.
  ownerTokenHash: { type: String },
  status: { type: String, enum: ['pending', 'completed', 'failed'], default: 'pending' },
  termsAcceptanceId: { type: mongoose.Schema.Types.ObjectId, ref: 'TermsAcceptance' },
}, { timestamps: true });

module.exports = mongoose.model('Payment', paymentSchema);