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

## Phase 5 and later

Not documented here until built.
