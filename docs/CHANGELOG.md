# Changelog — Security Hardening

A phase-by-phase record of the hardening work, one entry per commit. Each entry
states the commit, what behavior changed (before → after), the files changed, and
the tests added. Phase 5 and later are intentionally not documented until built.

## Phase 1 — Hardening

### f266cb0 — fix(proxy): bounded trust proxy; use req.ip, ignore spoofed XFF
- **Behavior:** Before, the proxy trust setting let a client spoof
  `X-Forwarded-For` and control `req.ip`. After, Express trusts a fixed number of
  proxy hops read from `TRUST_PROXY` (default 1), and the audit/terms paths read
  the resolved `req.ip` so the recorded client IP is the real one for the
  configured hop count.
- **Files changed:** `.env.example`, `server.js`,
  `src/controllers/paymentController.js`, `src/controllers/termsController.js`,
  `tests/wiring.test.mjs`.
- **Tests added:** `tests/wiring.test.mjs` — client-IP / trustworthy-proxy tests.

### b2f7c08 — feat(config): min secret length and fail-fast MONGO_URI
- **Behavior:** Before, a production secret was only rejected when it was a
  documented placeholder, and a missing `MONGO_URI` did not stop startup early.
  After, production refuses to start when `ADMIN_KEY`, `ADMIN_SESSION_SECRET` or
  `INTASEND_WEBHOOK_CHALLENGE` is absent, a known placeholder, or shorter than 16
  characters, and a missing/blank `MONGO_URI` is fatal (test env exempt).
- **Files changed:** `.env.example`, `server.js`, `src/config/envGuard.js`,
  `tests/envGuard.test.mjs`.
- **Tests added:** `tests/envGuard.test.mjs` — minimum-secret-length and
  startup-config tests.

### dfc5583 — feat(validation): max-length caps on free-text fields
- **Behavior:** Before, listing/store free-text fields could be arbitrarily long.
  After, fixed maximum lengths are enforced on listing and store creation and
  update, and mirrored in the models.
- **Files changed:** `src/config/inputLimits.js`,
  `src/controllers/listingController.js`,
  `src/controllers/paymentController.js`, `src/controllers/storeController.js`,
  `src/models/Listing.js`, `src/models/Store.js`, `tests/wiring.test.mjs`.
- **Tests added:** `tests/wiring.test.mjs` — over-cap rejection tests.

### f3c26bc — feat(rate-limit): throttle payment status endpoint
- **Behavior:** Before, `GET /api/payments/status/:invoiceId` was unlimited.
  After, it is throttled by a dedicated limiter (default 60 requests/minute per
  IP, tunable via `STATUS_RATE_LIMIT`).
- **Files changed:** `.env.example`, `src/middleware/rateLimiter.js`,
  `src/routes/payments.js`, `tests/adminLockout.test.mjs`,
  `tests/statusLimiter.test.mjs`.
- **Tests added:** `tests/statusLimiter.test.mjs` (new).

**Existing tests changed:**
- `tests/envGuard.test.mjs` — the `require` line was extended to also import
  `assertStartupConfig`; fixtures `ADMIN_KEY: 'strong-key'` →
  `'strong-admin-key-123456'` and `ADMIN_SESSION_SECRET: 'strong-secret'` →
  `'strong-session-secret-1234'` (to satisfy the new 16-character minimum). The
  `'strong-challenge'` value (exactly 16 characters) was left unchanged.
- `tests/adminLockout.test.mjs` — added one line `statusLimiter: pass(),` to the
  fake rate-limiter module.

## Phase 2 — Payment Integrity

### 33b59b7 — fix(payments): reject store_id at listing creation
- **Behavior:** Before, a listing payment could carry a `store_id` and create an
  already-attached listing. After, `initiateListing` rejects any `store_id` other
  than undefined/null/'' with 400 before any IntaSend or `Payment.create` call.
- **Files changed:** `src/controllers/paymentController.js`,
  `tests/wiring.test.mjs`.
- **Tests added:** `tests/wiring.test.mjs` — store_id rejection tests.

### 59563e9 — fix(payments): never attach a store at payment completion
- **Behavior:** Before, webhook completion could persist a `store_id` on the
  created listing. After, the listing branch forces `store_id: null` after the
  listing data spread (the store-plan branch is unchanged).
- **Files changed:** `src/controllers/paymentController.js`,
  `tests/wiring.test.mjs`.
- **Tests added:** `tests/wiring.test.mjs` — "store_id null after completion"
  tests.

### 6bad14d — fix(payments): owner-only boost; hide boost UI for non-owners
- **Behavior:** Before, anyone could initiate a boost for any listing and the
  boost UI was shown to everyone. After, boost requires a valid `X-Owner-Token`
  (owner or authenticated admin) and returns 403 otherwise, and the boost section
  renders only for token holders. The ownership helpers `isOwnerOrAdmin` and
  `safeEqual` were moved to `src/middleware/listingAuth.js`.
- **Files changed:** `public/assets/js/app.js`,
  `src/controllers/listingController.js`, `src/controllers/paymentController.js`,
  `src/middleware/listingAuth.js`, `tests/domTerms.test.mjs`,
  `tests/wiring.test.mjs`.
- **Tests added:** `tests/domTerms.test.mjs` — boost UI ownership gate;
  `tests/wiring.test.mjs` — owner-only boost tests.

**Existing tests changed:**
- `tests/wiring.test.mjs` — the "initiate-boost 503 on IntaSend failure" test:
  the `lst-plain` fixture gained `ownerTokenHash: sha256hex('boost-owner-token')`
  and the request gained `.set('X-Owner-Token', 'boost-owner-token')`.

## Phase 3 — Contact Release

### 3a04391 — refactor(privacy): shared public view serializer for contact fields
- **Behavior:** Before, each read endpoint stripped contact fields inline. After,
  `getListings`, `getListing`, `getStore`, `getStoreById` and `getMyStores` route
  through shared `listingView`/`storeView` helpers that always remove
  `ownerTokenHash` and remove seller/store contact unless `includeContact` is
  true. No response shape changed for existing callers.
- **Files changed:** `src/controllers/listingController.js`,
  `src/controllers/storeController.js`, `src/utils/publicView.js`,
  `tests/publicView.test.mjs`.
- **Tests added:** `tests/publicView.test.mjs` (new).

### 5af4ccc — feat(contact): release seller contact only after recorded acceptance
- **Behavior:** Before, `POST /api/terms/contact-acceptance` trusted a
  `sellerWhatsapp` from the request body and returned no contact at all. After, it
  validates the acceptance token before any lookup, resolves only a live approved
  listing, releases that listing's **stored** number, records its hash, sets
  `Cache-Control: no-store`, and is capped by a per-IP hourly limiter (default 40,
  `CONTACT_RELEASE_LIMIT`). The body-supplied number is ignored.
- **Files changed:** `.env.example`, `src/controllers/termsController.js`,
  `src/middleware/rateLimiter.js`, `src/routes/terms.js`,
  `tests/adminLockout.test.mjs`, `tests/contactReleaseLimiter.test.mjs`,
  `tests/wiring.test.mjs`.
- **Tests added:** `tests/contactReleaseLimiter.test.mjs` (new);
  `tests/wiring.test.mjs` — contact-release tests.

### fa71fe4 — fix(contact): buyer gets seller contact via explicit WhatsApp link
- **Behavior:** Before, the buyer gate sent a DOM-held number in the request body
  and auto-opened `wa.me` via `window.open`. After, the gate posts only the
  `listingId`; on success it renders an "Open WhatsApp" anchor built from the
  number the server released, and it never calls `window.open`. The per-listing
  detail backfill that existed only to populate the contact button was removed.
- **Files changed:** `public/assets/js/app.js`, `tests/domTerms.test.mjs`.
- **Tests added:** `tests/domTerms.test.mjs` — buyer contact gate tests.

**Existing tests changed:**
- `tests/wiring.test.mjs` — the fake `Listing.findOne` gained a bounded `_id`
  branch (plain equality plus `$in`/`$nin`/`$ne`), and the "records the trusted
  client IP…" test gained a seeded listing fixture
  (`_id: '650000000000000000000042'`).
- `tests/adminLockout.test.mjs` — added one line `contactReleaseLimiter: pass(),`
  to the fake rate-limiter module.
- `tests/domTerms.test.mjs` — the `vitest` import line gained `beforeEach`, the
  fetch stub was extended to answer `/terms/contact-acceptance`, and a
  `window.open` spy was added.

## Phase 4 — Moderation

### c4538fa — feat(moderation): checkStore sharing the listing pattern runner
- **Behavior:** Before, stores were not screened at all. After, the listing
  pattern loop is extracted into a shared `runPatterns` helper and a new
  `checkStore` screens the store's free-text fields (name, description, category,
  subcategories, location, pickup_location, opening_hours, closing_hours,
  open_days, payment_methods). `checkListing` output is unchanged.
- **Files changed:** `src/services/moderationService.js`,
  `tests/moderation.test.mjs`.
- **Tests added:** `tests/moderation.test.mjs` (new).

### b141d1e — fix(moderation): re-check content on listing edits; block edits to removed listings
- **Behavior:** Before, listing edits bypassed the blocklist. After, the merged
  document is re-screened and the listing is flagged when needed (never
  auto-approved), and a removed listing returns 409 on any edit attempt.
- **Files changed:** `src/controllers/listingController.js`,
  `tests/wiring.test.mjs`.
- **Tests added:** `tests/wiring.test.mjs` — listing-edit moderation tests.

### 579d99d — fix(moderation): moderate new stores; hide flagged stores from public
- **Behavior:** Before, new stores were created unscreened and only removed
  stores were hidden. After, store creation runs `checkStore` and sets
  `moderationStatus`, and the public slug route hides both flagged and removed
  stores (`$nin`) while owners keep access.
- **Files changed:** `src/controllers/paymentController.js`,
  `src/controllers/storeController.js`, `tests/wiring.test.mjs`.
- **Tests added:** `tests/wiring.test.mjs` — store moderation tests.

### ee1f67b — fix(moderation): re-check content on store edits; block removed resources
- **Behavior:** Before, store edits bypassed the blocklist and a removed listing
  could still be attached. After, store edits re-screen the merged document
  (never auto-approved), a removed store returns 409 on edit, and a removed
  listing returns 409 on attach (detach unchanged).
- **Files changed:** `src/controllers/storeController.js`,
  `tests/wiring.test.mjs`.
- **Tests added:** `tests/wiring.test.mjs` — store-edit and attach-guard tests.

### 6e6af1e — docs: admin moderation runbook
- **Behavior:** Documentation only; no runtime behavior changed.
- **Files changed:** `docs/runbook-moderation.md`.
- **Tests added:** None.

**Existing tests changed:**
- `tests/wiring.test.mjs` — the fake Store's `findOne` moderation check was
  replaced: the inline `$ne`-only expression became
  `matchesModFilter(s, filter.moderationStatus)`, with a new `matchesModFilter`
  helper supporting plain equality plus `$in`/`$nin`/`$ne` (a missing field
  passes `$nin`/`$ne`).

## Phase 5A — Store visibility and seller block list

### Step 1 — Hide the inventory of hidden stores
- **Behavior:** Before, `GET /api/listings?store_id=<id>` returned a store's
  approved listings regardless of the store's own state. After, the store is
  resolved first and its inventory is hidden when the store is suspended,
  flagged or removed; a missing store or a malformed store id returns the normal
  success envelope with an empty list and zero counts (status 200), so store
  existence is not revealed. Requests without `store_id` are unchanged and never
  look up a store.
- **Files changed:** `src/controllers/listingController.js`.
- **Tests added:** `tests/wiring.test.mjs` — hidden-store inventory gate tests.
- **Existing tests changed:** `tests/wiring.test.mjs` — the fake Store model's
  `findOne` gained a bounded `_id` matcher (`matchesStoreId`: plain equality plus
  `$ne`/`$nin`/`$in`, missing field passes `$ne`/`$nin`).

### Step 2 — Seller block list, model and admin endpoints
- **Behavior:** Before, there was no way to block a seller contact and no admin
  surface for one. After, an admin can block the contacts behind a listing, a
  store, or a raw Kenyan number; the block is stored only as the sha256 of the
  normalized number, and `POST`/`GET /api/admin/blocks` and
  `DELETE /api/admin/blocks/:id` are gated by the same admin session as the other
  admin views. The API never returns the number or the hash.
- **Files changed:** `src/utils/phone.js`, `src/models/BlockedContact.js`,
  `src/controllers/blockController.js`, `src/routes/adminAuth.js`.
- **Tests added:** `tests/phone.test.mjs` (new); `tests/wiring.test.mjs` — admin
  blocked-contact endpoint tests.
- **Existing tests changed:** `tests/wiring.test.mjs` — the model injection block
  gained a fake `BlockedContact` (create / findOne / find / findByIdAndDelete) and
  the shared `h` state gained `blocks`, cleared in the global `beforeEach`.

### Step 3 — Refuse payment initiation for blocked contacts
- **Behavior:** Before, a blocked contact could still start a payment. After,
  `initiate-listing` and `initiate-store-plan` refuse with 403 (`This number
  cannot be used on GikoMart`) when the payer number or the listing/store contact
  is blocked, and they do so before any IntaSend call, acceptance record or
  `Payment.create`. Boost, the webhook, replay and resource creation are
  unchanged; a payment that was already pending before a block can still
  complete.
- **Files changed:** `src/controllers/paymentController.js`.
- **Tests added:** `tests/wiring.test.mjs` — blocked-contact payment tests.
- **Existing tests changed:** None.

## Phase 5B — Keyed hashing, reports, audit events and retention

### Step 1 — Key the block-list hashes with BLOCK_HASH_SECRET
- **Behavior:** Before, `contactHash` returned a plain (unkeyed) SHA-256 of the
  normalized number. After, it returns HMAC-SHA256 keyed by `BLOCK_HASH_SECRET`
  (read at call time, never at module load); production refuses to start when the
  secret is missing, blank or shorter than 16 characters, and development/test
  fall back to a fixed constant so local runs and CI need no real value. Changing
  the secret invalidates existing blocks.
- **Files changed:** `.env.example`, `src/config/envGuard.js`,
  `src/utils/phone.js`.
- **Tests added:** `tests/phone.test.mjs` — keyed-hash tests (same-format,
  different-secret, not-plain-sha256, production throw, 15/16-character
  boundary, test-environment fallback); `tests/envGuard.test.mjs` —
  `BLOCK_HASH_SECRET` startup tests.
- **Existing tests changed:** `tests/phone.test.mjs` — the `vitest` import line
  gained `afterEach` and a `node:crypto` import was added (test-only; no existing
  assertion, status or test name changed). `tests/envGuard.test.mjs` — additions
  only, no existing line changed.

### Step 2 — Public reports, admin queue and resolution
- **Behavior:** Before, there was no way for a user to report a listing or store.
  After, `POST /api/reports` accepts a report (limited per IP per hour behind the
  honeypot), deduplicated per IP, target and 24-hour window while open; the
  reporter IP is stored only for deduplication and never returned. A
  session-gated admin queue (`GET /api/admin/reports`, open by default) and
  resolution (`PUT /api/admin/reports/:id/resolve`) let an admin close a report,
  recording the moderation action taken (`admin.report_resolved`) without
  applying any moderation itself.
- **Files changed:** `.env.example`, `server.js`, `src/config/inputLimits.js`,
  `src/controllers/reportController.js`, `src/middleware/rateLimiter.js`,
  `src/models/Report.js`, `src/routes/adminAuth.js`, `src/routes/reports.js`.
- **Tests added:** `tests/reportLimiter.test.mjs` (new); `tests/wiring.test.mjs`
  — user-report and admin-queue tests.
- **Existing tests changed:** `tests/adminLockout.test.mjs` — one line
  `reportLimiter: pass(),` added to the fake rate-limiter module.
  `tests/wiring.test.mjs` — the model injection block gained a fake `Report`
  model (create / findOne / find / findById / findByIdAndUpdate) and its
  injection line, the shared `h` state gained `reports` (cleared in the global
  `beforeEach`), the generic `matchesFilter` helper gained `$gte`, and the fake
  rate-limiter module gained a `reportLimiter` passthrough.

### Step 3 — Audit events for edits, auto-flags, attach/detach and payment views
- **Behavior:** Before, several privileged actions left no audit trail: listing
  edits, auto-flags (listing and store), store attach/detach and the admin
  payments view. After, each emits a fire-and-forget audit event —
  `listing.update` (field names and `autoFlagged` only, never values),
  `listing.auto_flagged`, `store.auto_flagged`, `store.attach_listing`,
  `store.detach_listing` and `admin.payments_viewed` — and no existing emit
  changed.
- **Files changed:** `src/controllers/adminController.js`,
  `src/controllers/listingController.js`, `src/controllers/storeController.js`.
- **Tests added:** `tests/wiring.test.mjs` — audit-event tests for edits,
  auto-flags, attach/detach and payment views.
- **Existing tests changed:** None.

### Step 4 — Strip report IPs and old payment PII
- **Behavior:** Before, report reporter IPs were kept indefinitely and a
  completed payment's payer number and seller/store contact copies were kept
  forever. After, the cleanup job nulls a report's `reporterIp` after 30 days and,
  90 days after creation, redacts `phoneNumber` (to `redacted`) and unsets
  `listingData.sellerWhatsapp`, `storeData.phone`, `storeData.whatsapp` and
  `storeData.email` on completed and failed payments (pending payments are never
  touched; `piiStrippedAt` makes it idempotent).
- **Files changed:** `src/models/Payment.js`, `src/services/cleanupService.js`.
- **Tests added:** `tests/retentionReportsPayments.test.mjs` (new).
- **Existing tests changed:** None.

## Phase 6 — Retention gaps and legal pages

### Step 1 — Strip old acceptance contact hashes and prune audit events
- **Behavior:** Before, `TermsAcceptance` records kept `actor.whatsappHash` and
  `sellerContactTarget.sellerWhatsappHash` forever, and audit events were kept
  forever. After, a 30-day job nulls both contact hashes (keeping
  `ownerTokenHash`, the listing/store ids, `listingTitle` and metadata), and a
  scheduled job deletes audit events older than `AUDIT_RETENTION_DAYS` (default
  365; a non-numeric or non-positive value falls back to 365). No existing strip
  function changed, and no model gained an index or TTL option.
- **Files changed:** `.env.example`, `src/services/cleanupService.js`.
- **Tests added:** `tests/retentionAcceptanceAudit.test.mjs` (new).
- **Existing tests changed:** None.

### Step 2 — Privacy policy page and fact sources
- **Behavior:** Documentation only; no runtime behavior changed. Adds a public
  privacy policy page describing what data is collected, why, which third-party
  providers receive it, what is stored in the browser, the enforced retention
  windows and data-subject rights, plus `docs/LEGAL_FACTS.md` recording the
  source of every factual statement on the page.
- **Files changed:** `docs/LEGAL_FACTS.md` (new),
  `public/legal/privacy-policy.html` (new).
- **Tests added:** None.
- **Existing tests changed:** None.

### Step 3 — Prohibited items page and data requests page
- **Behavior:** Documentation only; no runtime behavior changed. Adds a public
  prohibited-items page (the prohibited categories, what happens to listings that
  break the rules, and how to report a listing or store) and a public
  data-requests page (who may ask, what they may ask for, how to ask, what we
  need, what happens next, and what cannot be erased), and appends their source
  rows to `docs/LEGAL_FACTS.md`.
- **Files changed:** `docs/LEGAL_FACTS.md` (rows),
  `public/legal/prohibited-items.html` (new),
  `public/legal/data-requests.html` (new).
- **Tests added:** None.
- **Existing tests changed:** None.

### Step 4 — Footer links, placeholder register and page tests
- **Behavior:** Before, the three new legal pages were unreachable from the site.
  After, the footer links them, `docs/LEGAL_PLACEHOLDERS.md` registers the five
  placeholders that must be filled before launch, and `tests/legalPages.test.mjs`
  checks the pages are served, well-formed and free of scripts, inline handlers,
  64-hex strings and phone-like digit runs, and that the four versioned legal
  pages are unchanged.
- **Files changed:** `docs/LEGAL_PLACEHOLDERS.md` (new), `public/index.html`,
  `tests/legalPages.test.mjs` (new).
- **Tests added:** `tests/legalPages.test.mjs` (new).
- **Existing tests changed:** None.

### Step 5 — Data request runbook
- **Behavior:** Documentation only; no runtime behavior changed. Adds
  `docs/runbook-data-requests.md`: how to find a requester's records across each
  collection, erase the erasable contact PII, keep what cannot be erased, and log
  the request outside the database.
- **Files changed:** `docs/runbook-data-requests.md` (new).
- **Tests added:** None.
- **Existing tests changed:** None.

## Phase 7 — Admin health, metrics and portal

### Step 1 — Minimal public health and detailed admin health
- **Behavior:** Before, `GET /health` reported MongoDB and Cloudinary (a `checks`
  object plus `timestamp`) and returned 503 only when MongoDB was down. After,
  `GET /health` returns only `{ status: 'healthy' }` with HTTP 200 when MongoDB is
  up, or `{ status: 'unhealthy' }` with HTTP 503 when it is not, so uptime
  monitors keep working without dependency details being exposed. A new
  session-gated `GET /api/admin/health` returns the detailed view — `success`,
  `status` (`healthy`/`degraded`/`unhealthy`), `checks` (`mongodb`, `cloudinary`),
  `timestamp` and `uptimeSec` — always with HTTP 200; the Cloudinary ping is
  bounded by a 5-second timeout.
- **Files changed:** `docs/API_AND_CONFIG.md`, `docs/DECISIONS.md`,
  `src/controllers/adminController.js`, `src/routes/adminAuth.js`,
  `src/routes/health.js`, `tests/health.test.mjs` (new), `tests/wiring.test.mjs`.
- **Tests added:** `tests/health.test.mjs` (new, 6 tests);
  `tests/wiring.test.mjs` (1 test).
- **Existing tests changed:** None.

### Step 2 — Admin metrics endpoint
- **Behavior:** Before, there was no way to see site totals. After, a new
  session-gated `GET /api/admin/metrics` returns counts and revenue: active and
  flagged listings, active/flagged/suspended stores, pending/completed-24h/
  failed-24h payments, revenue totals for 24h/7d/30d (labelled `KSh`, split by
  payment type for 30 days), open reports and total blocks. The computation lives
  in `src/services/metricsService.js`; it performs ten `countDocuments` calls and
  one `Payment.aggregate` pipeline in a single `Promise.all`, coerces every
  number to a finite value, and ignores aggregate rows whose type is unknown.
  Metrics contain no personal data, so no audit event is emitted.
- **Files changed:** `docs/API_AND_CONFIG.md`, `docs/DECISIONS.md`,
  `src/controllers/adminController.js`, `src/routes/adminAuth.js`,
  `src/services/metricsService.js` (new), `tests/adminMetrics.test.mjs` (new),
  `tests/wiring.test.mjs`.
- **Tests added:** `tests/adminMetrics.test.mjs` (new, 7 tests);
  `tests/wiring.test.mjs` (2 tests).
- **Existing tests changed:** `tests/wiring.test.mjs` — Authorization A fake
  additions only (`countDocuments` on the Store, Payment, Report and
  BlockedContact fakes; `aggregate` on the Payment fake).

### Step 3 — Static options, portal shell, sign-in, dashboard and health tabs
- **Behavior:** Before, the `express.static` options were inline in `server.js`
  and there was no admin portal. After, the static options live in
  `src/config/staticOptions.js`; the admin portal and its script and stylesheet
  are served with `Cache-Control: no-store` and `X-Robots-Tag: noindex, nofollow`
  while every other file keeps its previous caching. A new static portal at
  `/admin/` (not linked from any public page) signs in with the admin key plus a
  TOTP code, holds the session token only in memory (never browser storage) and
  renders a Dashboard tab (all sixteen metrics) and a Health tab (status,
  MongoDB, Cloudinary, checked time, uptime). All portal content is built with
  `createElement` and `textContent`; there is no inline script and no `robots.txt`.
- **Files changed:** `docs/API_AND_CONFIG.md`, `docs/DECISIONS.md`,
  `docs/runbook-admin-portal.md` (new), `public/admin/index.html` (new),
  `public/assets/css/admin.css` (new), `public/assets/js/admin.js` (new),
  `server.js`, `src/config/staticOptions.js` (new),
  `tests/adminPortal.test.mjs` (new), `tests/staticHeaders.test.mjs` (new).
- **Tests added:** `tests/staticHeaders.test.mjs` (new, 8 tests);
  `tests/adminPortal.test.mjs` (new, 16 tests).
- **Existing tests changed:** None.

### Step 4 — Reports and payments tabs
- **Behavior:** Before, the portal had only the Dashboard and Health tabs. After,
  a **Reports** tab lists reports (filterable by status and target type, `open`
  by default) and lets an admin apply a moderation action (two-click confirmed)
  and then record a resolution; a **Payments** tab lists payments (filterable by
  status and type) with payer phone numbers masked, and offers a two-click
  replay for non-completed payments that carry an invoice id. Both tabs render
  all values as text.
- **Files changed:** `docs/DECISIONS.md`, `docs/runbook-admin-portal.md`,
  `public/admin/index.html`, `public/assets/js/admin.js`,
  `tests/adminPortal.test.mjs`.
- **Tests added:** `tests/adminPortal.test.mjs` (14 tests).
- **Existing tests changed:** None.

### Step 5 — Blocks and audit log tabs, final docs
- **Behavior:** Before, the portal had no way to manage blocked contacts or read
  the audit trail. After, a **Blocks** tab adds a block (from a phone number, a
  listing id or a store id), lists blocks and removes one (two-click confirmed) —
  the typed phone number is never shown again after submit; an **Audit log** tab
  reads audit events with optional action and resource filters, truncates each
  event's metadata to 200 characters, and pages with "Load older" using the last
  row's `before` timestamp. The `.env.example` Analytics note now says only the
  GoatCounter site code is hardcoded (PostHog is not loaded on any public page),
  and the portal runbook is complete.
- **Files changed:** `.env.example`, `docs/CHANGELOG.md`,
  `docs/runbook-admin-portal.md`, `public/admin/index.html`,
  `public/assets/js/admin.js`, `tests/adminPortal.test.mjs`.
- **Tests added:** `tests/adminPortal.test.mjs` (13 tests).
- **Existing tests changed:** None.

## Phase 9b — Grant accounting

### feat(admin): preview before granting and cap grant selectors
- **Behavior:** Before, the Grant tab granted whichever pending payment matched a
  selector, with no way to see which payment that would be. After, a new
  `POST /api/admin/grant-preview` (same session gate and selector validation,
  read-only) returns the payment that a grant would claim. Both grant routes now
  cap their selectors — `paymentId` 24, `invoiceId` 64, `phoneNumber` 20
  characters — and return **400 `{ success: false, error: 'Invalid selector' }`**
  when a cap is exceeded. The preview response carries `{ id, type, package,
  storePlan, amount, createdAt, title, storeName, phoneMasked }`, where `title`
  (from `listingData.title`) and `storeName` (from `storeData.name`) are capped at
  80 characters and null when absent, and `phoneMasked` masks a plain digit
  number as first 4 + `***` + last 2 (unchanged otherwise). In the portal the
  Grant tab gains a **Preview** button; the Grant button stays disabled until a
  preview succeeds for the current input values and is disabled again on any
  edit, and the grant request sends only the previewed payment's id as
  `paymentId`.
- **Files changed:** `docs/API_AND_CONFIG.md`, `docs/CHANGELOG.md`,
  `docs/DECISIONS.md`, `public/assets/js/admin.js`, `src/routes/adminGrant.js`,
  `tests/grantPortal.test.mjs`, `tests/grantPreview.test.mjs`.
- **Tests added:** `tests/grantPreview.test.mjs` (13 tests),
  `tests/grantPortal.test.mjs` (5 tests).
- **Existing tests changed:** `tests/adminGrant.test.mjs`, one UI case updated for
  the preview-then-grant flow (approved).

### feat(metrics): exclude admin grants from revenue and count them separately
- **Behavior:** Before, revenue was the sum of `Payment.amount` for every
  `status: 'completed'` payment, so an admin grant (which produces the same
  `completed` status) inflated the revenue totals. After, `computeMetrics`'s
  revenue aggregate matches on `grantedAt: null`, so only genuinely paid
  payments count toward revenue, and a new `payments.granted30d` count
  (`status: 'completed', grantedAt: { $ne: null }`, last 30 days) reports grants
  separately. The admin dashboard renders that count as a **Free grants
  (30 days)** metric directly after **Failed payments (24h)**. No other metric key
  changed.
- **Files changed:** `docs/CHANGELOG.md`, `public/assets/js/admin.js`,
  `src/services/metricsService.js`, `tests/adminMetricsGrants.test.mjs`.
- **Tests added:** `tests/adminMetricsGrants.test.mjs` (4 tests).
- **Existing tests changed:** `tests/adminMetrics.test.mjs` and
  `tests/adminPortal.test.mjs`, assertions updated for the new metric (approved).

### feat(admin): mark payments completed by an admin grant
- **Behavior:** Before, a payment completed by `POST /api/admin/grant-free-access`
  was indistinguishable from one completed by a real IntaSend webhook — both just
  had `status: 'completed'`. After, the `Payment` schema carries two new fields,
  `grantedBy` (String, default null) and `grantedAt` (Date, default null). The
  grant route's atomic claim now writes `grantedBy: adminActor(req)` and
  `grantedAt` in the same `$set`, so a granted payment is stamped with the acting
  admin and the time. Webhook-completed payments leave both null. The
  `admin.grant_free_access` audit event also gains a `grantedAt` ISO string in its
  metadata (the actor is already recorded as `actor`).
- **Files changed:** `docs/CHANGELOG.md`, `docs/DECISIONS.md`,
  `src/models/Payment.js`, `src/routes/adminGrant.js`, `tests/grantMarking.test.mjs`.
- **Tests added:** `tests/grantMarking.test.mjs` (3 tests).
- **Existing tests changed:** None.

## Phase 9 — fixes

### fix(admin): never replace an enrolled 2FA factor
- **Behavior:** Before, a caller holding the admin key and a valid TOTP code
  could re-run `POST /api/admin/setup-2fa` and overwrite the enrolled admin's
  TOTP secret. After, the secret-storing `findOneAndUpdate` filter excludes an
  account with `totpEnabled: true`, so the unique `username` index makes the
  write fail with a duplicate-key error (`11000`), which is returned as
  **409 `{ success: false, error: '2FA is already enabled' }`**. The enrolled
  secret is left byte-identical.
- **Files changed:** `docs/CHANGELOG.md`, `docs/DECISIONS.md`,
  `src/controllers/adminAuthController.js`, `tests/setup2faGuard.test.mjs`.
- **Tests added:** `tests/setup2faGuard.test.mjs` (3 tests).

## Phase 8 — Report and save/retry frontend hardening

### Earlier commit db7f145 (retroactive)
- **Behavior:** Added the report affordance and save/retry button states to the
  frontend. In `public/assets/js/app.js` the store edit flow gained
  `Saving…` → `Saved ✓` → `Save Changes` (and `Retry` on failure) button states,
  the store-plan and boost flows gained a `Sending payment request…` busy state,
  and the report modal (`setupReportModal`, `openReportModal`,
  `closeReportModal`, `handleReportSubmit`) was added, wired to
  `POST /api/reports` through the existing `data-action` delegation. In
  `public/index.html` the report modal markup was added. In
  `public/assets/css/style.css` the report-modal, `.modal-sm`, `.modal-actions`
  and `.btn-sm` styles were added.
- **Files changed:** `public/assets/css/style.css`,
  `public/assets/js/app.js`, `public/index.html`.
- **Tests added:** None at the time (added in Phase 8).

### fix(ui): harden report entry points and add tests
- **Behavior:** The listing detail Report button now renders only when the app
  is not in demo mode, and both Report buttons escape the target id into the
  `data-target-id` attribute with `escapeAttr` (a hostile id can no longer break
  out of the attribute). A successful report submission now clears the reason
  and details fields and resets the submit button to `Submit Report`. A single
  document-level `keydown` listener closes the report modal on Escape when it is
  open, otherwise closes the listing modal; the store modal is deliberately
  left open.
- **Files changed:** `docs/CHANGELOG.md`, `docs/DECISIONS.md`,
  `public/assets/js/app.js`, `tests/reportModal.test.mjs`.
- **Tests added:** `tests/reportModal.test.mjs` (15 tests).
- **Existing tests changed:** None.

### test(ui): cover store save and retry states
- **Behavior:** No source change. Adds coverage for the store edit save flow
  that already existed: the `Saving…` disabled state while the PUT is pending,
  the `Saved ✓` → `Save Changes` success transition and modal close after
  2000 ms, the `Retry` failure state (modal open, typed values kept, friendly
  500 toast), the second PUT from Retry with the owner-token header, and the
  offline message on a rejected fetch.
- **Files changed:** `docs/CHANGELOG.md`, `tests/storeSave.test.mjs`.
- **Tests added:** 5; source changed: none.
- **Existing tests changed:** None.

### docs(legal): prohibited items page reflects the Report button
- **Behavior:** Section 3 of `public/legal/prohibited-items.html` now points at
  the in-page Report button ("Use the Report button on any listing or store
  page and choose a reason…") instead of saying the button is not yet
  available. The matching row in `docs/LEGAL_FACTS.md` was re-sourced to the
  report buttons and the `POST /reports` call in `public/assets/js/app.js`.
- **Files changed:** `docs/CHANGELOG.md`, `docs/LEGAL_FACTS.md`,
  `public/legal/prohibited-items.html`, `tests/prohibitedReport.test.mjs`.
- **Tests added:** `tests/prohibitedReport.test.mjs` (2 tests).
- **Existing tests changed:** None.

### fix(ui): escape listing card data-id
- **Behavior:** `listingCardHTML` now writes the listing id into the card's
  `data-id` attribute with `escapeAttr(l._id)`. A hostile id (e.g. one
  containing a quote) round-trips exactly through `dataset.id` instead of
  truncating at the quote.
- **Files changed:** `docs/CHANGELOG.md`, `public/assets/js/app.js`,
  `tests/cardIdEscape.test.mjs`.
- **Tests added:** `tests/cardIdEscape.test.mjs` (1 test).
- **Existing tests changed:** None.

## Phase 8b — Upload retention, moderation matching, backup runbook

### fix(ui): keep the previous photo when a replacement upload fails
- **Behavior:** Before, a failed replacement photo upload cleared
  `uploadedImageUrl`, so the listing was submitted with no image even though a
  photo had already been confirmed, and the preview stayed on the rejected
  pick. After, `setupImageUpload` snapshots the confirmed URL and preview when a
  new upload starts and restores both on failure, and the status line appends
  " Your previous photo was kept." when a previous photo was restored. With no
  previous photo the behavior is unchanged (no image, the same error text).
- **Files changed:** `docs/CHANGELOG.md`, `docs/DECISIONS.md`,
  `public/assets/js/app.js`, `tests/imageUploadRetention.test.mjs`.
- **Tests added:** `tests/imageUploadRetention.test.mjs` (4 tests).
- **Existing tests changed:** None.

### feat(moderation): match normalized and de-spaced text
- **Behavior:** Before, moderation tested only the haystack as written, so
  look-alike digits ("c4s1n0"), single-letter spacing ("c a s i n o"),
  zero-width characters and full-width letters slipped past the blocklist.
  After, `runPatterns` tests three variants — the text as written, its
  normalized form, and its normalized-and-de-spaced form — and flags if any
  variant matches. Look-alike digits/symbols are converted only when they touch
  a letter, so numbers and prices are never altered; a clean, untriggered input
  returns the same shape as before. No pattern text was added.
- **Files changed:** `docs/CHANGELOG.md`, `docs/DECISIONS.md`,
  `src/services/moderationService.js`, `tests/moderationEvasion.test.mjs`.
- **Tests added:** `tests/moderationEvasion.test.mjs` (9 tests).
- **Existing tests changed:** None.

### test(ops): backup script safety tests and restore runbook
- **Behavior:** Before, `scripts/backup.js` had no test proving it fails safely
  or that it never prints the connection string or its credentials, and there
  was no restore runbook. After, `tests/backupScript.test.mjs` runs the script
  as a real child process (explicit env, scratch cwd so no `.env` is read) and
  asserts a non-zero exit with no `mongodb` string when `MONGO_URI` is unset,
  no credential leak when `mongodump` is missing, that `backups/` is ignored by
  git, and that the source does not log the URI variable or the whole
  `process.env`. `docs/runbook-backup-restore.md` documents the backup, the
  Atlas continuous-backup manual step, a scratch-namespace restore drill, the
  post-drill cleanup, and the out-of-repo schedule. The script itself needed no
  change — every safety case already passed.
- **Files changed:** `docs/CHANGELOG.md`, `docs/DECISIONS.md`,
  `docs/runbook-backup-restore.md`, `tests/backupScript.test.mjs`.
- **Tests added:** `tests/backupScript.test.mjs` (4 tests).
- **Existing tests changed:** None.

### docs: lost authenticator recovery runbook
- **Behavior:** Added a "Lost authenticator (recovery)" section to
  `docs/runbook-admin-portal.md` covering database recovery of the enrolled
  authenticator.
- **Step 4: lost authenticator recovery runbook. Docs only. Tests added: none.
  Existing tests changed: none.**

## Institution neutrality

### feat(branding): remove institution-specific branding, copy and defaults
- **Behavior:** Before, GikoMart presented itself as a marketplace for a named
  university: the homepage and all seven legal pages carried an institutional
  location tag, the hero and footer copy named the university, the Terms of
  Service scoped the service to that university and its neighbouring communities,
  restricted use to members of its community, and gave a contact address at the
  university's town, the npm description and a keyword named the university, and
  new Store records defaulted `campus` to the university while new Listing
  records defaulted `location` to the university's town (the `campus` field is
  returned by the public store API). After, no page or metadata names an
  institution: the location tags and copy use **Njoro** or neutral local wording
  ("local WhatsApp groups", "local marketplace … for students, residents, and
  surrounding communities"), the Terms audience is institution-neutral, the ToS
  contact address is the `[OPERATOR_ADDRESS]` placeholder, the npm metadata is
  neutral, and the location defaults are `campus: 'Njoro'` and `location: 'Njoro'`.
  No route, environment variable, limiter, schema shape, payment/store/listing
  flow or admin behavior changed; the `campus` field is retained (compatibility)
  with a neutral default. Git-ignored generated browser artifacts that reproduced
  the old branding (`.playwright-mcp/`, `ui-preview-top.png`) were removed.
- **Files changed:** `package.json`, `public/index.html`,
  `public/ui-preview/index.html`, `public/legal/{terms-of-service,privacy-policy,
  buyer-terms,seller-terms,store-owner-terms,prohibited-items,data-requests}.html`,
  `public/assets/js/app.js`, `src/models/Store.js`, `src/models/Listing.js`,
  `src/controllers/paymentController.js`, `docs/LEGAL_FACTS.md`,
  `docs/ui-audit/audit-report.md`, `docs/ui-audit/design-system.md`,
  `tests/{auditTrail,termsAcceptance,wiring,xssEscaping}.test.mjs`,
  `tests/legalPages.test.mjs`.
- **Tests added:** None.
- **Existing tests changed:** `tests/auditTrail.test.mjs`,
  `tests/termsAcceptance.test.mjs`, `tests/wiring.test.mjs`,
  `tests/xssEscaping.test.mjs` — inert sample location fixture values → `'Njoro'`
  (no assertion, status or test name changed).
  `tests/legalPages.test.mjs` — the four pinned SHA-256 hashes of the versioned
  legal pages were recomputed for the intentional copy change (and the comment
  updated); no assertion was weakened, skipped or removed.

## Phase 9c — Access-log IP

### fix(logging): log req.ip instead of the raw forwarded header
- **Behavior:** Before, the access log's `ip` field was
  `req.headers['x-forwarded-for'] || req.socket.remoteAddress`, so a client could
  choose its own logged address by sending an `X-Forwarded-For` header, and a
  multi-hop chain was logged as one comma-separated string. After, the field is
  `req.ip` — the same address the rate limiters and the admin lockout use, resolved
  by Express through the configured `trust proxy` hop count. No other behavior
  changed.
- **Files changed:** `server.js`.
- **Tests added:** `tests/requestLogIp.test.mjs` (new) — trust-proxy detection, a
  three-hop chain resolving to the client address, a spoofed one-entry chain, and
  a no-comma assertion.
- **Existing tests changed:** none.

## Phase 9d — Admin TOTP drift window and replay

### fix(admin): honor the ±1 TOTP drift window in login without weakening replay
- **Behavior:** Before, `POST /api/admin/login` verified the code with
  `verifyDelta({ window: 1 })` (speakeasy's two-sided ±1 step tolerance) but then
  rejected any result with `delta < 0`, so a code from the immediately **previous**
  30-second step was refused as `"Invalid TOTP code"`. The replay check also stored
  the server's *current* step (`counter`) rather than the step the code belonged to.
  After, a null `verifyDelta` result is the only outright rejection; the replay
  guard rejects a code whose step is `<= lastUsedCounter` and records the accepted
  step. A code from the previous step is now accepted once (drift tolerance) and a
  reused code is still rejected as `"TOTP code already used"`. No secret, config or
  response shape changed; replay protection is preserved.
- **Files changed:** `src/controllers/adminAuthController.js`.
- **Tests added:** `tests/adminTotpLogin.test.mjs` (new, 10 deterministic tests with
  a mocked clock) — valid current code accepted and a verifiable session issued;
  invalid code rejected; out-of-window code rejected; used code rejected (replay);
  fresh code accepted in the next step; wrong admin key rejected; missing code
  rejected; previous- and next-step codes accepted once and then replay-blocked.
- **Existing tests changed:** none.

## Phase 10 — Free Grant

### feat(free-grant): admin-approved free package that converges on paid provisioning
- **Behavior:** Before, a seller could only acquire a listing/store package by
  paying through IntaSend; the existing admin "Grant Free Access" could only
  complete an already-existing pending payment, so a first-time seller could not
  be granted anything. After, a seller can submit a Free Grant request
  (`POST /api/grants`) for a listing package or store plan; it becomes `pending`.
  An admin reviews the queue (`GET /api/admin/grants`, phone masked) and approves
  or rejects it (atomic `pending → approved|rejected`). On approval the SELLER
  redeems on their own device (`POST /api/grants/:claimId/redeem`), which mints
  the owner token in that request and creates the resource through the existing
  `createResourceForPayment()`. The resulting Store/Listing is a normal record:
  same moderation, expiry, listing limits and owner-token ownership as a paid
  one. No `Payment` row is written and no revenue is recorded. The paid flow and
  the existing Grant Free Access are unchanged.
- **Schema:** new `GrantRequest` collection (`whatsapp`, `contactHash`,
  `claimTokenHash` unique, `type`, `package`/`storePlan`, `status`,
  `decidedBy`/`decidedAt`, `provisionedAt`, `listingId`/`storeId`). Additive only.
- **Files changed:** `src/models/GrantRequest.js`,
  `src/controllers/grantController.js`, `src/routes/grants.js`,
  `src/routes/adminGrants.js`, `src/utils/ownerToken.js`, `server.js`,
  `public/index.html`, `public/assets/js/app.js`, `public/admin/index.html`,
  `public/assets/js/admin.js`.
- **Tests added:** `tests/grantRequest.test.mjs` (27 tests) — request validation
  and blocked-contact/honeypot handling; claim-token verification; admin queue,
  approval/rejection and single-approval atomicity; provisioning for both listing
  and store; moderation; idempotent redeem; and proof that no payment is created.
- **Existing tests changed:** `tests/adminPortal.test.mjs` — the tab-order
  assertion now includes the new "Grant requests" tab.

## Phase 10b — Free Grant seller UX states

### feat(ui): explicit free-grant feedback for every state of the request
- **Behavior:** Before, submitting a Free Grant request left the request form
  visible under a small continuation note, so a seller could not tell whether
  the request was submitted, pending, failed or what to do next. After, the
  modal walks an explicit state machine: submitting (button
  `Submitting request…`, disabled, in-flight guard against duplicate submits),
  submitted/pending (persistent state replacing the form, with
  `Status: Pending admin approval`, that submitted ≠ approved is stated
  explicitly, the requested package/type and WhatsApp number, and Check
  status / Close actions), approved (`Your free grant was approved 🎉` before
  the existing redemption form), rejected (explicit terminal state, no success
  wording, stored claim cleared), and failure (button restored, friendly
  message, entered values kept). After a reload the modal offers to resume the
  request still stored on the device instead of inviting a duplicate. No API,
  payload, endpoint, polling mechanism or backend behavior changed: the same
  `POST /api/grants` and `GET /api/grants/status/:claimId` are used, and
  polling still reuses the payment-status backoff schedule.
- **Files changed:** `public/assets/js/app.js`.
- **Tests added:** `tests/grantUx.test.mjs` (10 JSDOM tests driving the real
  `app.js`) — submitting state and duplicate-click protection, pending state
  content, manual status check, claim token kept out of URLs, approval and
  rejection transitions, failure recovery, and reload/resume behaviour.
- **Existing tests changed:** none.

## Phase 10c — Live incident: stale app.js silently disabled new UI

### fix(ops): cache-bust app.js and bound the JS/CSS cache lifetime
- **Behavior:** Before, `assets/js/app.js` was served with `Cache-Control:
  public, max-age=604800` (a week) while `index.html` was revalidated on every
  load. After a deploy, returning visitors therefore ran the OLD script against
  the NEW markup: the delegated dispatcher has no case for a newly added
  `data-action`, so the new **Request Free Grant** button did nothing at all —
  no modal, no request, no error. Confirmed live on production: a stale browser
  ran an 86,903-byte pre-grant `app.js` (`window.openGrantModal === undefined`)
  while the origin served the current 116,453-byte script, and only a
  fresh-profile browser worked. After, `index.html` references
  `assets/js/app.js?v=20261004a` (new cache key → every visitor immediately
  fetches the current script), and non-admin JS/CSS is served with
  `public, max-age=300` so any future missed version bump self-heals within
  minutes instead of persisting for a week. HTML and admin assets are
  unchanged (already `max-age=0` / `no-store`); images keep the week-long
  cache.
- **Files changed:** `public/index.html`, `src/config/staticOptions.js`,
  `tests/staticHeaders.test.mjs`.
- **Tests changed:** `tests/staticHeaders.test.mjs` — the public-asset header
  assertion now encodes the short JS/CSS TTL plus a regression test that
  `index.html` always references a versioned `app.js`.

## Phase 10d — Free Grant lifecycle: broadcast parity, admin history, cross-device continuation

(Working-tree changes documented as built; not yet committed — production still
runs `7654a0e`.)

### feat(free-grant): listings redeemed from a grant broadcast like paid ones
- **Behavior:** Before, only the paid webhook path announced a newly created
  listing to the configured WhatsApp groups (`broadcastListing` in
  `paymentController`), so a listing created through Free Grant redemption was
  silent on the broadcast channel. After, a successful grant redemption calls
  the SAME `broadcastListing` for `type: 'listing'`, under the same rules as
  the paid path: only when moderation approved it (`moderationStatus ===
  'approved'` — flagged listings are skipped both ways), fire-and-forget so a
  broadcast failure is logged and never undoes provisioning, and store grants
  never broadcast (stores have no broadcast mechanism). `WHATSAPP_GROUPS`
  unset still no-ops safely.
- **Files changed:** `src/controllers/grantController.js`,
  `tests/grantLifecycle.test.mjs`.
- **Tests added:** `tests/grantLifecycle.test.mjs` (new) — approved listing
  grant broadcasts exactly once with the created document; flagged grant is
  not broadcast; a broadcast failure never rolls back provisioning; a store
  grant never triggers the listing broadcast; no `Payment` row is created
  anywhere in the extended lifecycle.
- **Existing tests changed:** none.

### feat(admin): full WhatsApp number in the grant queue plus a status history filter
- **Behavior:** Before, the session-gated admin queue returned and displayed
  only the masked number (`2547***78`), which made a wa.me follow-up
  impossible, and `GET /api/admin/grants` knew only
  `status=pending|approved|rejected` with a silent pending fallback. After,
  the queue response carries the FULL normalized number (`whatsapp`, rendered
  as the "WhatsApp Seller" wa.me anchor) alongside `whatsappMasked` for any
  surface that prefers masking — the full number still appears on no public
  endpoint, and a session-less request still leaks nothing. The admin UI adds
  a history filter (pending default, approved, rejected, and a derived
  `provisioned` view that fetches `status=approved` and filters provisioned
  rows client-side, because sending a bogus status to the API would fall back
  to pending).
- **Files changed:** `src/controllers/grantController.js`,
  `public/assets/js/admin.js`, `tests/grantRequest.test.mjs`,
  `tests/grantLifecycle.test.mjs`, `tests/adminGrantsUi.test.mjs`.
- **Tests added:** `tests/grantLifecycle.test.mjs` — full number returned only
  in the authenticated admin response (with the masked form kept), raw claim
  token and stored hash absent from the list payload, session-less request
  leaks nothing, status filtering with `provisioned` derived on approved rows,
  unknown status falls back to pending. `tests/adminGrantsUi.test.mjs` (new,
  JSDOM over the real admin portal) — full number displayed, wa.me anchor
  built from the normalized number, no anchor when the number is missing,
  filter default and reload behaviour, provisioned derived client-side.
- **Existing tests changed:** `tests/grantRequest.test.mjs` — the admin list
  assertion now requires the full `whatsapp` AND the absence of any token or
  hash material.

### feat(free-grant): cross-device continuation for the claim credential (seller link + admin mint)
- **Behavior:** Before, the claim token lived only in the submitting browser's
  localStorage: clearing storage or switching devices made an approved grant
  unredeemable, with no recovery path. After, the credential can be moved two
  deliberate ways. (1) Seller-side: the pending card offers "Continue on
  another device", building a `#grant=<claimId>/<token>` URL HASH fragment
  from the seller's OWN stored token — `app.js` captures the hash at
  script-parse time and scrubs it (`history.replaceState`) before analytics or
  any server contact, then resumes through the existing localStorage + poll
  flow; `public/index.html` sends `Referrer-Policy: no-referrer` so the
  fragment can never leak via Referer. (2) Admin-side: a session-gated action
  (`POST /api/admin/grants/:id/continuation-token`) atomically replaces the
  stored `claimTokenHash` with the hash of a newly generated 192-bit token for
  an approved, NOT-yet-provisioned grant — revoking the old token by the write
  itself, reusing the same single credential system (no schema change),
  keeping comparison timing-safe, and returning the raw token exactly once in
  that response only: never in the grant list, never logged, never written to
  audit events. The admin UI renders the fragment link, a wa.me message
  carrying it, and a copy action on the eligible row only (two-click
  confirmed); the token is never rendered as page text, and minting again
  rotates the credential. A dead `grant-continue` dispatcher case (markup
  nothing generated) was removed.
- **Files changed:** `src/routes/adminGrants.js`,
  `src/controllers/grantController.js`, `public/assets/js/app.js`,
  `public/assets/js/admin.js`, `public/index.html`,
  `tests/grantContinuation.test.mjs`, `tests/grantLifecycle.test.mjs`,
  `tests/adminGrantsUi.test.mjs`, `tests/grantUx.test.mjs`.
- **Tests added:** `tests/grantContinuation.test.mjs` (new, 7) — parse-time
  hash capture/scrub/malformed handling and the resume flow.
  `tests/adminGrantsUi.test.mjs` — mint button appears only on approved,
  unprovisioned rows; the minted row renders the `#grant=` link, wa.me
  message and copy action without exposing the token as page text; a failed
  mint surfaces the API error. `tests/grantLifecycle.test.mjs` mint block —
  rotation replaces the stored hash and revokes the old token (old token 401,
  new token works, stale token cannot redeem), the raw token appears only in
  the mint response (absent from the list and the audit event), 409 for
  pending/rejected/provisioned, 404 unknown / 400 malformed id, unauthenticated
  401 that leaks nothing and rotates nothing.
- **Existing tests changed:** `tests/grantUx.test.mjs` — the approved-state
  copy now introduces the redemption form ("Your grant is approved and ready
  …").

### feat(ui): one-click "Copy WhatsApp message" handoff in the seller's pending state
- **Behavior:** Before, a seller who wanted the admin on WhatsApp had to
  assemble the message themselves — what they requested, their number, and (if
  they knew to use it) the continue-on-another-device link from the separate
  dialog. After, the pending card's primary button, **Copy WhatsApp message**,
  puts the entire handoff on the clipboard in ONE action: a greeting, the
  human-readable request description (`Request: Quick Sale (24h) — listing
  package`), the contact number as typed, and the private `#grant=<claimId>/
<token>` hash-fragment link with a keep-it-private note. The link is built
  from the seller's own stored token (the same credential the Continue dialog
  moves); if no token is readable, an honest message without a link is copied
  instead of a broken one. The action is purely client-side (zero network
  requests), the token is never rendered into the page (it travels only in
  the copied text), and the button confirms with `Copied ✓` plus a status
  line. Refactor: the copy mechanics moved into a shared
  `copyTextToClipboard` helper (clipboard API with execCommand fallback) used
  by both this button and the Continue dialog. `app.js` cache key bumped to
  `?v=20261005b`.
- **Files changed:** `public/assets/js/app.js`, `public/index.html`,
  `tests/grantUx.test.mjs`.
- **Tests added:** `tests/grantUx.test.mjs` — one click copies greeting,
  request details, number and the exact `#grant=grant-1/tok-abc` fragment
  with no additional network requests; the claim token is never rendered into
  the page even after the copy; a missing token still yields an honest,
  link-free message.
- **Existing tests changed:** none.

### feat(ops): volume alerting for continuation-token minting (credential-rotation abuse signal)
- **Behavior:** Before, nothing flagged unusual minting volume — an admin
  session rotating credentials for far more grants than lost tokens could
  justify (mass re-targeting of unprovisioned grants, or a compromised
  session) was visible only by manually reading the audit log. After, every
  successful mint fire-and-forgets a lightweight evaluation that counts
  `admin.grant_continuation_minted` events in the trailing ONE-HOUR window
  via the existing audit collection (no new state, no extra write on the mint
  path) and, at or above the threshold, logs a warn line and writes a
  `admin.grant_mint_volume_alert` audit event carrying only
  `{ count, windowMinutes, threshold }` — never token material. The alarm is
  advisory ONLY: it never blocks, delays, rate-limits or alters the mint
  response, and a failed evaluation (or alert write) is swallowed so the mint
  always succeeds. Threshold via `GRANT_MINT_ALERT_THRESHOLD` (positive
  integer, default 5 when unset or invalid; read at call time so tests and
  deployments can change it without a restart).
- **Files changed:** `src/services/grantMintAlert.js` (new),
  `src/controllers/grantController.js`, `.env.example`,
  `tests/grantLifecycle.test.mjs`.
- **Tests added:** `tests/grantLifecycle.test.mjs` alert block — silent below
  the threshold; alert at the threshold with correct actor/resource/metadata
  and no token material; invalid threshold falls back to the default of 5;
  the mint still succeeds when the evaluation throws; the evaluation queries
  the minted action within a one-hour window.
- **Existing tests changed:** none (the lifecycle fake AuditEvent gained a
  `countDocuments` stub, reset to 0 per test).

### docs: grants-queue runbook (SOP for review, minting and safe sending)
- **Files changed:** `docs/runbook-grant-requests.md` (new),
  `docs/runbook-admin-portal.md` (tabs list now points at it).
- Covers: reading the queue and its four filters, when minting a continuation
  token is (and is not) appropriate, the mint-and-send procedure with the
  once-only display and social-engineering guardrails, what each grant audit
  action means (including the volume alert and its reconciliation rule), and
  recovery for minted-but-not-sent or never-redeemed grants.

### docs: deploy runbook for the Free Grant lifecycle shipment
- **Files changed:** `docs/runbook-deploy-free-grant.md` (new).
- Covers: preconditions (full gate green, cache-bust newer than production),
  the two-commit shape, push-and-watch Render deploy, the `?v=` marker that
  proves the new build is serving, header/API/seller/admin verification steps
  (including assisted sign-in and the do-not-mint-five-times alert rule), and
  rollback with revert + the 5-minute JS TTL self-heal.

### docs: repo-wide audit for claims outdated by the Free Grant lifecycle
- **Behavior:** a sweep of every living document, legal page and UI-copy
  surface against the shipped lifecycle found three substantive gaps, now
  fixed. (1) `public/legal/privacy-policy.html` did not disclose the
  GrantRequest record (WhatsApp number, request, decision) or the grant claim
  token stored in browser local storage — the data inventory gained a
  Free Grant row and §5 gained the claim-token bullet. (2)
  `docs/runbook-data-requests.md` had no way to find or erase a requester's
  Free Grant records — section 2 gained the `db.grantrequests` find (plain
  plus HMAC form) and section 3 the contact-field erasure. (3)
  `docs/runbook-backup-restore.md` verified restores against only three
  collections — now seven (adds grantrequests, termsacceptances,
  auditevents). `docs/LEGAL_FACTS.md` gained the matching code-backed fact
  rows. Verified-and-unchanged: the admin-portal runbook's Payments masking
  text (payments still mask; only the grants queue shows full numbers),
  `LEGAL_PLACEHOLDERS.md`, `AGENT_RULES.md`, `AUDIT_INPUTS.md`, the ui-audit
  docs, the phase gate reports (point-in-time records, not living claims),
  and the seller-facing copy in `app.js` (the "The admin will not ask for
  it" and "no payment needed" lines are accurate as shipped). No README
  exists at the repo root; nothing referenced the pre-lifecycle grant
  behavior anywhere else.

### feat(admin): QA/test marker for grant requests (queue-level separation from real sellers)
- **Behavior:** Before, an agent-submitted test grant request was
  indistinguishable from a real seller's submission in the admin queue — the
  only signals were out-of-band (a throwaway WhatsApp number, the audit log's
  `adminActor` decisions). After, a request can carry an `isTest` flag: the
  grants queue renders a **QA/test** badge next to the request type on flagged
  rows, and every row (any status) offers a two-click **Mark QA/test /
  Unmark QA/test** toggle backed by `POST /api/admin/grants/:id/qa-flag`
  (`{ isTest: boolean }` body; the body is not trusted for anything else).
  The flag is deliberately COSMETIC: the decision lifecycle (approve, reject,
  redeem, mint) is unchanged for marked requests, marking is allowed for any
  status and correctable at any time, and the list endpoint accepts an
  optional `?isTest=true|false` query filter (absent → unfiltered, the
  previous behavior). The flag never appears on unauthenticated paths
  (session-gated admin route as every other grant action), and each toggle
  writes an `admin.grant_test_flag_set` audit event carrying only
  `{ isTest }` — never token material. No new index; the flag defaults to
  `false`, so pre-existing rows are unmarked.
- **Files changed:** `src/models/GrantRequest.js`,
  `src/controllers/grantController.js`, `src/routes/adminGrants.js`,
  `public/assets/js/admin.js`, `public/assets/css/admin.css`,
  `tests/grantLifecycle.test.mjs`, `tests/adminGrantsUi.test.mjs`.
- **Tests added:** `tests/grantLifecycle.test.mjs` QA block (6) — mark + queue
  exposure; unmark and untouched real rows; 404 unknown / 400 malformed /
  401 unauthenticated leaking nothing; lifecycle parity (approve + redeem
  succeed on a marked grant); audit events per toggle without token material;
  `?isTest=` filtering both ways. `tests/adminGrantsUi.test.mjs` (2) — badge
  only on flagged rows with the correct toggle label per state; the toggle
  POSTs the opposite value and reloads the queue.
- **Existing tests changed:** `tests/grantLifecycle.test.mjs` — the fake
  GrantRequest `findOneAndUpdate` now applies a status filter only when the
  caller supplies one (the QA toggle deliberately has none), and `find`
  honors an `isTest` filter.

### docs: decision record #36 — Free Grant approval is terminal
- **Files changed:** `docs/DECISIONS.md` (new record #36),
  `docs/runbook-grant-requests.md`.
- Records why the `pending → approved` transition has no reverse edge: the
  one-way guarded state machine (approve/reject match the current status in
  the atomic update; redeem claims `approved` + `provisioned: null`; a
  backwards edge would race a redemption or provisioning and strand minted
  continuation credentials), the audit trail's monotonic
  submitted → approved → (mint) → redeem narrative with `decidedBy`/
  `decidedAt` written exactly once, and the abuse math of a reversible human
  gate on a payment-bypassing provisioning path. Names the narrower
  correction paths that exist instead (reject for pending, the cosmetic QA
  flag, moderation for a produced resource, a hypothetical future `revoked`
  terminal state). The grants-queue runbook now points at the record where it
  asserts there is no unapprove path.

### feat(admin): "Why can't I unapprove?" note in the grants queue
- **Files changed:** `public/assets/js/admin.js`, `public/assets/css/admin.css`,
  `tests/adminGrantsUi.test.mjs`.
- Adds a one-line muted note under the queue intro that answers the question
  where it actually forms: approval is a one-way atomic write — reversing it
  could race an in-flight redemption or provisioning, strand minted
  continuation tokens, and break the audit trail — with a link to
  `docs/DECISIONS.md` record #36 (GitHub blob URL, new tab,
  `rel="noopener noreferrer"`; the repo docs are not served by the app).
  Rendered through a new `.view-note` style; content is still inserted as
  text, never HTML (decision #22).
- **Tests added:** `tests/adminGrantsUi.test.mjs` (1) — the note renders with
  the rationale text and the decision-record link (target/rel checked).

### docs: align reversibility language everywhere with decision record #36
- **Files changed:** `docs/API_AND_CONFIG.md`,
  `docs/runbook-admin-portal.md`, `src/models/GrantRequest.js`,
  `src/controllers/grantController.js`, `src/routes/adminGrants.js` (the last
  three comments only).
- Sweep of every runbook and code comment for anything implying a grant
  decision can be reversed. Already aligned (no change): the grants runbook's
  recovery section ("deliberately no admin path to force one"), the deploy
  runbook ("approval is terminal"), the moderation and data-requests runbooks
  (resource-level levers, not decision edits), `LEGAL_FACTS.md`, the seller
  copy in `app.js`, and the portal note. Aligned now: the API doc's
  approve/reject step (both terminal + pointer to #36), the portal runbook's
  tab bullet ("both terminal — there is no unapprove path"), the approve
  section header in `grantController.js` (matches reject's "terminal"), the
  `status` field comment in the model (one-way lifecycle; `pending` written
  only at creation), and an explicit no-unapprove guard comment on the
  approve/reject routes in `adminGrants.js` — the file where such a route
  would be added. Behavior unchanged; no test changes.

### perf(upload): tune compression to 1280px/3MB and harden lazy loading
- **Behavior:** Before, uploads accepted 5 MB files and were re-encoded at a
  1600×1600 ceiling; only 1 of 7 rendered `<img>` tags lazy-loaded. After,
  uploads are capped at 3 MB (`fileSize: 3 * 1024 * 1024`), sharp resizes to
  1280×1280 (`fit: 'inside'`, `withoutEnlargement` unchanged), the 400 error
  message and all user-facing "max 5MB" copy now say 3MB (server error string,
  sell-form client pre-check, Free Grant client pre-check, upload hints in
  index.html/app.js/ui-preview), and every remaining `<img>` render in app.js
  (listing detail, both store logos, grant upload preview) plus both static
  preview images in index.html carries `loading="lazy"`. Security surface
  unchanged: `limitInputPixels` stays 25M, `file-type` magic-byte sniffing,
  quality 80, semaphore, and rate limits untouched.
- **Files changed:** `src/routes/upload.js`, `public/assets/js/app.js`,
  `public/index.html`, `public/ui-preview/index.html`, `tests/wiring.test.mjs`,
  `docs/CHANGELOG.md`, `docs/API_AND_CONFIG.md`.
- **Tests updated:** `tests/wiring.test.mjs` — oversize rejection now built at
  3 MB + 1 byte; pixel-bomb test's under-limit assertion now 3 MB; the
  "buffer already within" assertion now 1280px.

### perf: lazy-load store cover background images via IntersectionObserver
- **Behavior:** Before, the public store page rendered its cover as an inline
  `background:url('…w_1200…')`, fetching the ~1200px Cloudinary derivative
  immediately on store-page open even when the cover was off-screen (native
  loading="lazy" does not apply to CSS backgrounds). After, the render emits
  `<div class="lazy-bg" style="height:200px; background-position:center;
  background-size:cover;" data-bg="…">` with no background-image, and a
  shared IntersectionObserver (threshold 0.1, one-shot unobserve, WeakSet
  dedupe) swaps the URL into `style.backgroundImage` when the element is 10%
  visible; where IntersectionObserver is unavailable (old browsers, jsdom) the
  URL is applied immediately. Escape contract unchanged (escapeAttr on
  data-bg; the applied `url("…")` strips characters that could terminate the
  CSS string).
- **Files changed:** `public/assets/js/app.js`, `public/assets/css/style.css`,
  `public/index.html` (cache-bust ?v=20261006b), `docs/CHANGELOG.md`.
- **Tests:** no test changes; tests/xssEscaping's hostile cover_url probe
  exercises the new path (jsdom has no IntersectionObserver → immediate-apply
  fallback) and still asserts no injected elements / no window.__XSS.

### test: controllable IntersectionObserver stub + deferred cover-load coverage
- **Behavior:** none — test infrastructure only (no product file touched, no
  cache-bust). jsdom has no IntersectionObserver, so tests could previously
  reach only app.js's immediate-apply fallback for lazy backgrounds; now a
  stub can be installed before the app.js import to hold every lazy
  background un-applied until the test fires the intersection itself.
- **Files changed:** `tests/intersectionObserverStub.mjs` (new — reusable
  stub: records callback/options, tracks observed elements, `trigger(el,
  isIntersecting)` / `triggerAll()`, per-instance registry),
  `tests/lazyBackgrounds.test.mjs` (new — drives the real app.js + index.html
  store page through the observer path: data-bg placeholder unapplied at
  open, shared observer with threshold 0.1, non-intersecting entries ignored,
  intersecting entry applies the URL once + swaps lazy-bg → bg-loaded +
  one-shot unobserve, re-renders reuse the same observer),
  `docs/CHANGELOG.md`.
- **Tests added:** 5 (suite grows to 50 files). `tests/xssEscaping.test.mjs`
  unchanged — it keeps covering the fallback path and the escaping contract.

### perf: responsive srcset/sizes for listing card and detail images
- **Behavior:** Before, every device fetched one fixed Cloudinary derivative —
  the card its `w_400,h_400,c_fill` square crop, the detail modal its
  `w_800` — regardless of viewport or device pixel ratio. After, both renders
  emit `srcset`/`sizes`: the card ladder is 400/600/800 (the square c_fill
  crop scales with the width so every rung keeps the 1:1 crop), the detail
  ladder 400/800/1280 (1280 = the upload pipeline's max dimension; the
  existing `w_800` src stays as fallback). `sizes` values reflect measured
  rendered widths (style.css: .app-shell auto-fill minmax(240px,1fr) grid ≈
  350px desktop column / full-width phone column; .modal-card 460px − 2×28px
  padding ≈ 404px). Non-Cloudinary URLs emit no srcset at all — plain src
  keeps fallback duty and hostile values gain no new sink (escapeAttr on the
  assembled value; a malformed srcset degrades to src, per spec).
- **Files changed:** `public/assets/js/app.js` (cloudinarySrcset +
  responsiveImageAttrs helpers beside cloudinaryResize; card + detail call
  sites), `public/index.html` (cache-bust ?v=20261006c),
  `tests/responsiveImages.test.mjs` (new), `docs/CHANGELOG.md`.
- **Coverage:** listingCardHTML is the single card renderer (browse grid,
  my-listings, store page, store listings) — one change, four surfaces.

### docs: record keep-public decision for POST /api/upload (final security doc sweep)
- **Behavior:** Documentation only — no runtime change. `docs/security/AUDIT_INPUTS.md` §10
  now records the deliberate keep-public decision for `POST /api/upload` with rationale
  (sellers upload before any credential exists; no seller-session mechanism exists to gate
  on), the bounded risk accepted (anonymous Cloudinary storage abuse under the 10/min +
  100/24h per-IP limits), and the pre-analyzed future options (owner-token pre-issuance or
  seller auth) if abuse is observed. §10's control table gains the previously undocumented
  layer 11 (24h orphan sweep). `docs/API_AND_CONFIG.md`'s `/api/upload` row now lists
  `uploadDailyLimiter` (added in 323cf05 but missing from the row) and links the decision.
- **Files changed:** `docs/security/AUDIT_INPUTS.md`, `docs/API_AND_CONFIG.md`,
  `docs/CHANGELOG.md`.
- **Tests added:** none (documentation-only change; suite remains 60 files / 667 passed /
  1 skipped).

### docs: add architecture map of the store/payment/listing/upload system
- **Behavior:** Documentation only — no runtime change. New
  `docs/ARCHITECTURE-store-payments-images.md` maps the system exactly as found at
  `342e444`: plan-based **listing** limits (5/10/15, attach-time live count — there is
  no image-quota system), the flat 6-image/listing cap, payment-born
  stores/listings with webhook idempotency, the public-by-decision upload pipeline
  and its 24h orphan sweep, the owner-token auth model, and cleanup/expiry flows.
  Every claim is line-referenced and the doc carries a verification appendix whose
  commands re-derive each finding. `API_AND_CONFIG.md` gains a pointer to it.
- **Files changed:** `docs/ARCHITECTURE-store-payments-images.md` (new),
  `docs/API_AND_CONFIG.md`, `docs/CHANGELOG.md`.
- **Tests added:** none (documentation-only change; suite remains 60 files / 667 passed /
  1 skipped).

## Phase 11 — Buyer gate

### fix(buyer-gate): re-enable Continue when the seller has no contact
- **Behavior:** Before, if `POST /api/terms/contact-acceptance` returned OK with
  no `sellerWhatsapp`, `_handleBuyerGateContinue` took no action: the Continue
  button stayed disabled on "Checking…" forever with no message (the only
  re-enable path was the error `catch`). After, an added `else` branch
  re-enables the button ("Continue & Contact Seller") and shows the toast
  "⚠️ This seller hasn't shared a contact number. Try another listing." The
  success branch renders the "Open WhatsApp" anchor unchanged; the 404 path is
  unchanged. Backend requirement for `sellerWhatsapp` at listing creation is
  intentionally NOT changed (see docs/DECISIONS.md entry 37).
- **Files changed:** `public/assets/js/app.js`, `public/index.html`
  (cache tag `20261006d` → `20261007a`), `.asset-hashes.json`,
  `tests/domTerms.test.mjs`, `docs/DECISIONS.md`, `docs/CHANGELOG.md`.
- **Tests added:** `tests/domTerms.test.mjs` — "an OK response with no
  sellerWhatsapp re-enables the Continue button with a toast" (812 total:
  811 passed, 1 skipped).

## Phase 5 and later

Not documented here until built.
