// Single source of truth for ADMIN/SUPPORT contact metadata — the channel a
// user uses to reach the GikoMart operator. This is deliberately separate from
// seller contact: seller WhatsApp numbers live on Listing/Store documents and
// are released through the contact-acceptance flow (_waMeLink/contactSeller in
// app.js, whatsappService.js broadcasts). Nothing here may be substituted into
// those seller-contact paths.
//
// The support email is intentionally NOT rendered on any public surface
// (homepage footer or legal pages); it is centralized here for backend and
// operational use. The public support channel is the homepage footer's
// "WhatsApp Support" link, which legal pages reference by wording.
const SUPPORT_CONTACT = Object.freeze({
  // Local Kenyan display form (what a user reads).
  supportPhoneLocal: '0776844298',
  // International form for wa.me destinations — https://wa.me/254776844298
  supportPhoneInternational: '254776844298',
  supportEmail: 'trendypulsee925@gmail.com',
  // Product identity only — no claim of legal registration is made anywhere.
  operatorName: 'GikoMart',
  // Broad locality only: the operator has no physical business premises, so
  // this must never be expanded into a street/postal address.
  operatorLocation: 'Njoro, Nakuru County, Kenya',
});

module.exports = SUPPORT_CONTACT;
