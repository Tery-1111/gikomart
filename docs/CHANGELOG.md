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

## Phase 5 and later

Not documented here until built.
