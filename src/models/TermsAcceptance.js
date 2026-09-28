const mongoose = require('mongoose');
const { ACCEPTANCE_TYPES, TERMS_VERSIONS } = require('../config/termsVersions');

const termsAcceptanceSchema = new mongoose.Schema({
  acceptanceType: {
    type: String,
    enum: Object.values(ACCEPTANCE_TYPES),
    required: true,
    index: true,
  },

  termsVersions: {
    gikomartTermsOfService: {
      type: String,
      required: true,
      default: TERMS_VERSIONS.GIKOMART_TERMS_OF_SERVICE,
    },
    storeOwnerTerms: { type: String },
    sellerTerms: { type: String },
    buyerTerms: { type: String },
  },

  action: { type: String, required: true },

  timestamp: { type: Date, default: Date.now, required: true, index: true },

  actor: {
    phoneHash: { type: String },
    whatsappHash: { type: String },
    ownerTokenHash: { type: String },
    ip: { type: String },
    userAgent: { type: String },
  },

  storeId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Store',
    index: true,
  },

  listingId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Listing',
    index: true,
  },

  paymentInvoiceId: { type: String, index: true },

  fee: {
    amount: { type: Number },
    currency: { type: String, default: 'KES' },
    label: { type: String },
  },

  sellerContactTarget: {
    sellerWhatsappHash: { type: String },
    listingTitle: { type: String },
  },

  metadata: { type: mongoose.Schema.Types.Mixed },
}, { timestamps: true });

termsAcceptanceSchema.index({ acceptanceType: 1, timestamp: -1 });
termsAcceptanceSchema.index({ 'actor.ownerTokenHash': 1, timestamp: -1 });
termsAcceptanceSchema.index({ 'actor.whatsappHash': 1, timestamp: -1 });

module.exports = mongoose.model('TermsAcceptance', termsAcceptanceSchema);
