# Legal Facts — sources

Every factual statement on a legal page is listed here with the file and line
that proves it. A statement that cannot be sourced from the repository must not
appear on a page. Placeholders are listed with the page that uses them; they are
resolved in `docs/LEGAL_PLACEHOLDERS.md`.

| Claim | Source (file path and line number) | Page |
|---|---|---|
| GikoMart operates a campus marketplace and introduction platform for Egerton University and neighbouring communities. | `public/legal/terms-of-service.html:35` | Privacy Policy §1 |
| GikoMart is an introduction platform only and is not a party to user transactions. | `public/legal/terms-of-service.html:36` | Privacy Policy §1 |
| The minimum age to use GikoMart is 18, or the age of majority in your jurisdiction. | `public/legal/terms-of-service.html:43` | Privacy Policy §1 |
| The operator name and address are placeholders. | `public/legal/privacy-policy.html` (`[OPERATOR_NAME]`, `[OPERATOR_ADDRESS]`) | Privacy Policy §1 |
| Listing details collected: title, category, condition, price, description, location and images. | `src/models/Listing.js:3-12` | Privacy Policy §2 |
| The seller's WhatsApp number is stored but is not shown publicly; it is released only through the contact-acceptance endpoint. | `src/utils/publicView.js:24`, `src/controllers/termsController.js:24-25,69-101` | Privacy Policy §2 |
| Listing photos are stored on Cloudinary. | `src/routes/upload.js:97` | Privacy Policy §2 |
| Store details collected: name, description, logo, cover image, category, subcategories, campus, location, pickup location, opening and closing hours, open days, delivery and pickup options and payment methods. | `src/models/Store.js:5-34` | Privacy Policy §2 |
| Store phone, WhatsApp and email are removed from public responses unless the requester is the owner or an administrator. | `src/utils/publicView.js:32-34` | Privacy Policy §2 |
| Store logo and cover images are stored on Cloudinary. | `src/routes/upload.js:97` | Privacy Policy §2 |
| The payer's phone number is stored on the payment record. | `src/models/Payment.js:8` | Privacy Policy §2 |
| The payer's phone number is sent to IntaSend to start the M-Pesa payment. | `src/services/paymentService.js:44,62,86` | Privacy Policy §2 |
| The listing or store details attached to a payment are held on the payment record while pending. | `src/models/Payment.js:6,18` | Privacy Policy §2 |
| Terms acceptance records contain the acceptance type, the terms versions, the action, the timestamp, hashes of the phone/WhatsApp/owner-token values, the IP address, the user-agent, and the listing/store identifiers. | `src/models/TermsAcceptance.js:5-32,55-60`, `src/services/termsAcceptanceService.js:70-88` | Privacy Policy §2 |
| Report records contain the target type and id, the reason, any details, the reporter IP and the resolution. | `src/models/Report.js:9-26` | Privacy Policy §2 |
| Every server request is logged with method, path, status, latency, IP address and user-agent. | `server.js:84-99` | Privacy Policy §2 |
| Audit records contain the actor, action, resource, resource id, result, metadata and timestamp. | `src/models/AuditEvent.js:12-18` | Privacy Policy §2 |
| The blocked-contact list stores a keyed hash of a phone number, its source type and id, a reason and the administrator who added it. | `src/models/BlockedContact.js:8-13`, `src/utils/phone.js:14-28` | Privacy Policy §2 |
| Uploaded images have their EXIF metadata stripped before storage. | `src/routes/upload.js:80-81` | Privacy Policy §2 |
| New listings are broadcast to the WhatsApp groups configured by the operator. | `src/services/whatsappService.js:1-71` | Privacy Policy §3 |
| We use IntaSend for payments. | `src/services/paymentService.js:1`, `package.json` `intasend-node` | Privacy Policy §4 |
| We use Cloudinary to store and serve images. | `src/config/cloudinary.js:1` | Privacy Policy §4 |
| We use Whapi.Cloud to broadcast listings to WhatsApp groups. | `src/services/whatsappService.js:4` | Privacy Policy §4 |
| We use Render for hosting (the app's default origin is gikomart.onrender.com). | `server.js:55`, `.env.example:24` | Privacy Policy §4 |
| We use MongoDB Atlas for the database. | `.env.example:26` | Privacy Policy §4 |
| We use Google Fonts for typefaces. | `public/index.html:7-9`, `server.js:34-35` | Privacy Policy §4 |
| We use GoatCounter for analytics. | `public/index.html:332`, `server.js:33,37` | Privacy Policy §4 |
| The site stores an ownership token for a listing in browser local storage. | `public/assets/js/app.js:12-16,296-302` | Privacy Policy §5 |
| The site stores an ownership token for a store in browser local storage. | `public/assets/js/app.js:62,310-316` | Privacy Policy §5 |
| The site stores a pending-payment token in browser local storage. | `public/assets/js/app.js:17,335-338` | Privacy Policy §5 |
| The server sets no cookies. | No `res.cookie`/`Set-Cookie`/`cookie-parser` anywhere in `src/` or `server.js` | Privacy Policy §5 |
| The home page loads the GoatCounter analytics script. | `public/index.html:332` | Privacy Policy §5 |
| Store contact and location fields are cleared 30 days after the store's expiry date. | `src/services/cleanupService.js:73-100` | Privacy Policy §6 |
| Terms acceptance IP, phone hash and user-agent are cleared 30 days after acceptance. | `src/services/cleanupService.js:106-127` | Privacy Policy §6 |
| Terms acceptance WhatsApp hashes are cleared 30 days after acceptance. | `src/services/cleanupService.js:135-160` | Privacy Policy §6 |
| Report reporter IPs are cleared 30 days after the report. | `src/services/cleanupService.js:165-180` | Privacy Policy §6 |
| Payment payer number and the stored seller/store contact copies are cleared 90 days after a completed or failed payment. | `src/services/cleanupService.js:186-207` | Privacy Policy §6 |
| Audit events are deleted 365 days after the event by default. | `src/services/cleanupService.js:211-225`, `.env.example:73-74` | Privacy Policy §6 |
| Listings are deleted when their paid period ends. | `src/services/cleanupService.js:41-70` | Privacy Policy §6 |
| Server log files, blocked-contact entries and the retained acceptance fields have no automatic erasure. | `src/services/cleanupService.js` (no job targets them); `docs/API_AND_CONFIG.md` "Data retention" | Privacy Policy §6 |
| Data subject rights: to be informed, access, correction, erasure, objection. | Operator commitment (mandated content); Data Protection Act, 2019 (Kenya) | Privacy Policy §7 |
| A request is answered within 14 days; the Data Requests page is at /legal/data-requests.html. | Operator commitment; `public/legal/data-requests.html` | Privacy Policy §7 |
| Complaints may be made to the Office of the Data Protection Commissioner of Kenya. | Operator commitment; Data Protection Act, 2019 (Kenya) | Privacy Policy §8 |
| Contact email and WhatsApp are placeholders. | `public/legal/privacy-policy.html` (`[SUPPORT_EMAIL]`, `[SUPPORT_WHATSAPP]`) | Privacy Policy §8 |
| The effective date is a placeholder shown at the top of the page. | `public/legal/privacy-policy.html` (`[EFFECTIVE_DATE]`) | Privacy Policy (header) |
| The prohibited categories follow the Terms of Service Prohibited Content & Conduct section. | `public/legal/terms-of-service.html:51-60` | Prohibited Items §1 |
| The list is not exhaustive. | `src/services/moderationService.js:12-13` | Prohibited Items §1 |
| New listings and stores are screened automatically at creation. | `src/services/moderationService.js:26-38,41-67` | Prohibited Items §2 |
| A matching listing is hidden from public view and is not broadcast. | `src/controllers/listingController.js` (approved-only public filter), `src/controllers/paymentController.js` (broadcast only when approved) | Prohibited Items §2 |
| Edits are screened again and a clean edit never clears an admin flag. | `src/controllers/listingController.js` (updateListing), `src/controllers/storeController.js` (updateStore) | Prohibited Items §2 |
| Administrators can flag or remove listings, and flag, remove or suspend stores. | `src/controllers/listingController.js` (moderateListing), `src/controllers/storeController.js` (moderateStore, suspendStore) | Prohibited Items §2 |
| A blocked phone number cannot start a payment. | `src/controllers/paymentController.js` (isContactBlocked) | Prohibited Items §2 |
| Removing a listing is permanent, and a removed listing cannot be edited or attached to a store. | `src/controllers/listingController.js` (deleteListing, updateListing 409), `src/controllers/storeController.js` (attachListing 409) | Prohibited Items §2 |
| The automatic filter is a first pass, not a human review of every listing, and no response time is promised. | `src/services/moderationService.js:1-9` | Prohibited Items §2 |
| Fees are governed by the Fees & Payments section of the Terms of Service. | `public/legal/terms-of-service.html:63-64` | Prohibited Items §2 |
| Reports can be sent by WhatsApp or email until an in-page Report button exists. | Operator commitment; placeholders `[SUPPORT_WHATSAPP]`, `[SUPPORT_EMAIL]` | Prohibited Items §3 |
| The effective date is a placeholder shown at the top of the page. | `public/legal/prohibited-items.html` (`[EFFECTIVE_DATE]`) | Prohibited Items (header) |
| GikoMart has no user accounts; browsing needs no registration. | `public/legal/terms-of-service.html:49` | Data Requests §1 |
| Sellers and store owners receive a one-time ownership token as their credential. | `public/legal/terms-of-service.html:49`, `public/assets/js/app.js:12-16` | Data Requests §1 |
| Data subject rights: to be informed, access, correction, deletion. | Operator commitment; Data Protection Act, 2019 (Kenya) | Data Requests §2 |
| Payer phone numbers are erased 90 days after a completed or failed payment. | `src/services/cleanupService.js:186-207` | Data Requests §2 |
| Acceptance-record IP, user-agent and phone hash are erased after 30 days. | `src/services/cleanupService.js:106-127` | Data Requests §2 |
| The WhatsApp hashes on acceptance records are erased after 30 days. | `src/services/cleanupService.js:135-160` | Data Requests §2 |
| Report IP addresses are erased after 30 days. | `src/services/cleanupService.js:165-180` | Data Requests §2 |
| Audit events are deleted after 365 days by default. | `src/services/cleanupService.js:211-225`, `.env.example:73-74` | Data Requests §2 |
| Requests are sent by email or WhatsApp (placeholders). | `public/legal/data-requests.html` (`[SUPPORT_EMAIL]`, `[SUPPORT_WHATSAPP]`) | Data Requests §3 |
| To find records we need the phone number used and the listing title or store name, and we may ask for proof of ownership. | Operator process; `src/models/Listing.js:11`, `src/models/Store.js:5` | Data Requests §4 |
| A request is answered within 14 days, and nothing else is promised about timing. | Operator commitment | Data Requests §5 |
| A seller can delete their own listing or store in the app. | `public/assets/js/app.js:1355-1375,1832-1845`, `src/routes/listings.js:18`, `src/routes/stores.js:17` | Data Requests §6 |
| Acceptance records are kept as evidence of consent after the PII erasure. | `src/services/cleanupService.js:106-160`, `docs/DECISIONS.md` 16 | Data Requests §6 |
| Audit events are kept for their retention window as an operational record. | `docs/DECISIONS.md` 17 | Data Requests §6 |
| The blocked-contact list keeps a keyed hash so a banned number cannot pay again. | `src/models/BlockedContact.js:1-15`, `docs/DECISIONS.md` 18 | Data Requests §6 |
| Payment amounts are kept for the dispute window after the contact PII is erased at 90 days. | `src/services/cleanupService.js:186-207`, `docs/DECISIONS.md` 15 | Data Requests §6 |
| The effective date is a placeholder shown at the top of the page. | `public/legal/data-requests.html` (`[EFFECTIVE_DATE]`) | Data Requests (header) |
